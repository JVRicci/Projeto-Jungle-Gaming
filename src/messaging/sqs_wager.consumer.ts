import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    type Message,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../application/use-cases/process_wager_transaction.use_case";
import type { MoneyProps } from "../domain/money/money";
import { DomainError } from "../domain/shared/domain-error";
import { WagerTransactionKind } from "../domain/wager/wager_transaction";
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
                console.error(
                    JSON.stringify({
                        level: "error",
                        event: "sqs_poll_error",
                        message: err instanceof Error ? err.message : String(err),
                    }),
                );
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
                await this.sqs.send(
                    new ChangeMessageVisibilityCommand({
                        QueueUrl: queueUrl,
                        ReceiptHandle: msg.ReceiptHandle,
                        VisibilityTimeout: 0,
                    }),
                );
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
            await this.sendToDlqAndAck(queueUrl, msg, "INVALID_ENVELOPE");
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

            console.log(
                JSON.stringify({
                    level: "info",
                    event: "sqs_wager_processed",
                    correlationId: messageId,
                    messageId,
                    transactionId: result.transactionId,
                    walletId: d.walletId,
                    providerId: d.providerId,
                    status: result.status,
                    idempotentReplay: result.idempotentReplay,
                }),
            );
        } catch (err) {
            // Erro permanente de contrato/domínio → DLQ + ack (não entra em retry infinito)
            if (err instanceof DomainError) {
                await this.sendToDlqAndAck(queueUrl, msg, err.code);
                return;
            }

            // Erro transitório (infra/Postgres) → NÃO dá ack; aplica backoff de visibilidade
            const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
            const backoffSeconds = Math.min(Math.pow(2, receiveCount), 30);
            console.error(
                JSON.stringify({
                    level: "error",
                    event: "sqs_wager_transient_error",
                    correlationId: messageId,
                    messageId,
                    walletId: d.walletId,
                    providerId: d.providerId,
                    receiveCount,
                    backoffSeconds,
                    message: err instanceof Error ? err.message : String(err),
                }),
            );
            await this.sqs.send(
                new ChangeMessageVisibilityCommand({
                    QueueUrl: queueUrl,
                    ReceiptHandle: receiptHandle,
                    VisibilityTimeout: backoffSeconds,
                }),
            );
        }
    }

    private async sendToDlqAndAck(queueUrl: string, msg: Message, reason: string): Promise<void> {
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
        console.error(
            JSON.stringify({
                level: "error",
                event: "sqs_message_sent_to_dlq",
                messageId: msg.MessageId,
                reason,
            }),
        );
    }
}