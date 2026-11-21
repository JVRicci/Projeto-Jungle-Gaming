import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    type Message,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import {
    Inject,
    Injectable,
    Optional,
    type OnModuleDestroy,
    type OnModuleInit,
} from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../application/use-cases/process_wager_transaction.use_case";
import type { MoneyProps } from "../domain/money/money";
import { DomainError } from "../domain/shared/domain-error";
import { WagerTransactionKind } from "../domain/wager/wager_transaction";
import { MetricsService } from "../observability/metrics.service";
import { StructuredLogger } from "../observability/structured_logger";
import { SQS_CLIENT } from "./sqs_client";

interface SqsWagerEnvelope {
    messageId?: string;
    type?: string;
    occurredAt?: string;
    data?: {
        providerId?: string;
        externalTransactionId?: string;
        idempotencyKey?: string;
        playerId?: string;
        walletId?: string;
        roundId?: string;
        gameId?: string;
        kind?: WagerTransactionKind;
        money?: MoneyProps;
        referenceExternalTransactionId?: string;
    };
}

const CONSUMER_NAME = "wager-transactions-consumer";
const VALID_KINDS = new Set<string>(Object.values(WagerTransactionKind));

@Injectable()
export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
    private stopping = false;
    private loopPromise: Promise<void> | null = null;

    constructor(
        @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
        private readonly processWager: ProcessWagerTransactionUseCase,
        @Optional() private readonly metrics?: MetricsService,
        @Optional() private readonly logger?: StructuredLogger,
    ) {}

    onModuleInit(): void {
        if (process.env.WORKERS_ENABLED === "false") return;
        this.loopPromise = this.runLoop();
    }

    async onModuleDestroy(): Promise<void> {
        this.stopping = true;
        if (this.loopPromise) {
            await this.loopPromise;
        }
    }

    private async runLoop(): Promise<void> {
        while (!this.stopping) {
            try {
                await this.pollOnce(5);
            } catch (err) {
                this.logger?.error("sqs_poll_error", {
                    reason: err instanceof Error ? err.name : "unknown",
                });
                await Bun.sleep(1000);
            }
        }
    }

    async pollOnce(waitTimeSeconds = 0): Promise<number> {
        const queueUrl = process.env.SQS_WAGER_QUEUE_URL;
        if (!queueUrl) {
            throw new Error("SQS_WAGER_QUEUE_URL não configurada");
        }

        const res = await this.sqs.send(
            new ReceiveMessageCommand({
                QueueUrl: queueUrl,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: waitTimeSeconds,
                MessageSystemAttributeNames: ["ApproximateReceiveCount"],
            }),
        );

        const messages = res.Messages ?? [];
        for (const msg of messages) {
            if (this.stopping && msg.ReceiptHandle) {
                // Devolve visibilidade imediatamente durante SIGTERM
                await this.changeVisibilitySafely(queueUrl, msg.ReceiptHandle, 0);
                continue;
            }
            await this.handleMessage(queueUrl, msg);
        }

        return messages.length;
    }

    private async handleMessage(queueUrl: string, msg: Message): Promise<void> {
        const receiptHandle = msg.ReceiptHandle;
        if (!receiptHandle) return;

        let envelope: SqsWagerEnvelope;
        try {
            envelope = JSON.parse(msg.Body ?? "") as SqsWagerEnvelope;
        } catch {
            await this.sendToDlqAndAck(queueUrl, msg, "INVALID_JSON");
            return;
        }

        const d = envelope.data;
        const messageId = envelope.messageId ?? msg.MessageId;
        if (
            !messageId ||
            !d?.providerId ||
            !d?.externalTransactionId ||
            !d?.playerId ||
            !d?.walletId ||
            !d?.roundId ||
            !d?.gameId ||
            !d?.kind ||
            !VALID_KINDS.has(d.kind) ||
            !d?.money
        ) {
            await this.sendToDlqAndAck(queueUrl, msg, "INVALID_ENVELOPE", {
                correlationId: messageId,
                messageId,
                walletId: d?.walletId,
                providerId: d?.providerId,
            });
            return;
        }

        const idempotencyKey =
            d.idempotencyKey?.trim() || `${d.providerId}:${d.externalTransactionId}`;

        try {
            // Commit atômico (inbox + wallet + ledger + wager + outbox) ANTES do ack
            const result = await this.processWager.execute({
                idempotencyKey,
                providerId: d.providerId,
                externalTransactionId: d.externalTransactionId,
                playerId: d.playerId,
                walletId: d.walletId,
                roundId: d.roundId,
                gameId: d.gameId,
                kind: d.kind,
                money: d.money,
                referenceExternalTransactionId: d.referenceExternalTransactionId,
                correlationId: messageId,
                inbox: { consumerName: CONSUMER_NAME, messageId },
            });

            await this.sqs.send(
                new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
            );

            this.logger?.info("sqs_wager_processed", {
                correlationId: messageId,
                messageId,
                transactionId: result.transactionId,
                walletId: d.walletId,
                providerId: d.providerId,
                status: result.status,
                idempotentReplay: result.idempotentReplay,
            });
        } catch (err) {
            // Erro permanente de contrato/domínio → DLQ + ack (não entra em retry infinito)
            if (err instanceof DomainError) {
                await this.sendToDlqAndAck(queueUrl, msg, err.code, {
                    correlationId: messageId,
                    messageId,
                    walletId: d.walletId,
                    providerId: d.providerId,
                });
                return;
            }

            // Erro transitório (infra/Postgres) → NÃO dá ack; aplica backoff de visibilidade
            this.metrics?.recordRetry("sqs");
            const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
            const maxBackoff = Number(process.env.SQS_MAX_BACKOFF_SECONDS ?? 30);
            const backoffSeconds = Math.min(2 ** receiveCount, maxBackoff);

            this.logger?.error("sqs_wager_transient_error", {
                correlationId: messageId,
                messageId,
                walletId: d.walletId,
                providerId: d.providerId,
                receiveCount,
                backoffSeconds,
                reason: err instanceof Error ? err.name : "unknown",
            });

            await this.changeVisibilitySafely(queueUrl, receiptHandle, backoffSeconds);
        }
    }

    private async changeVisibilitySafely(
        queueUrl: string,
        receiptHandle: string,
        seconds: number,
    ): Promise<void> {
        try {
            await this.sqs.send(
                new ChangeMessageVisibilityCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: receiptHandle,
                    VisibilityTimeout: seconds,
                }),
            );
        } catch (err) {
            this.logger?.warn("sqs_change_visibility_failed", {
                reason: err instanceof Error ? err.name : "unknown",
            });
        }
    }

    private async sendToDlqAndAck(
        queueUrl: string,
        msg: Message,
        reason: string,
        meta?: {
            correlationId?: string;
            messageId?: string;
            walletId?: string;
            providerId?: string;
        },
    ): Promise<void> {
        const dlqUrl = process.env.SQS_WAGER_DLQ_URL;
        if (dlqUrl) {
            await this.sqs.send(
                new SendMessageCommand({
                    QueueUrl: dlqUrl,
                    MessageBody: JSON.stringify({
                        reason,
                        originalMessageId: msg.MessageId,
                        originalBody: msg.Body,
                    }),
                    MessageGroupId: "dlq",
                    MessageDeduplicationId: msg.MessageId ?? crypto.randomUUID(),
                }),
            );
        }
        if (msg.ReceiptHandle) {
            await this.sqs.send(
                new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: msg.ReceiptHandle }),
            );
        }
        this.logger?.error("sqs_message_sent_to_dlq", {
            correlationId: meta?.correlationId ?? msg.MessageId,
            messageId: meta?.messageId ?? msg.MessageId,
            walletId: meta?.walletId,
            providerId: meta?.providerId,
            reason,
        });
        this.metrics?.recordDlq();
    }
}