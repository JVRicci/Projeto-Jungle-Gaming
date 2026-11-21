import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { UNIT_OF_WORK, type UnitOfWork } from "../ports/unit_of_work.port";
import { SQS_CLIENT } from "./sqs_client";
import { MetricsService } from "../observability/metrics.service";
import type { StructuredLogger } from "../observability/structured_logger";

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private stopping = false;
    private inFlight: Promise<unknown> = Promise.resolve();

    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
        @Optional() private readonly metrics?: MetricsService,
        @Optional() private readonly logger?: StructuredLogger
    ) {}

    onModuleInit(): void {
        if (process.env.WORKERS_ENABLED === "false") return;
        const intervalMs = Number(process.env.OUTBOX_POLL_MS ?? 500);
        this.timer = setInterval(() => {
            if (this.running || this.stopping) return;
            this.running = true;
            this.inFlight = this.publishBatchOnce()
                .catch((err) => {
                    this.logger?.error("outbox_poll_error", {
                        reason: err instanceof Error ? err.name : "unknown",
                    });
                })
                .finally(() => {
                    this.running = false;
                });
        }, intervalMs);
    }

    async onModuleDestroy(): Promise<void> {
        this.stopping = true;
        if (this.timer) clearInterval(this.timer);
        await this.inFlight;
    }

    async publishBatchOnce(limit = 20, now: Date = new Date()): Promise<number> {
        const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;
        if (!queueUrl) {
            throw new Error("SQS_EVENTS_QUEUE_URL não configurada");
        }

        return this.uow.run(async ({ outbox }) => {
            const batch = await outbox.claimPendingBatch(now, limit);
            let published = 0;

            for (const msg of batch) {
                try {
                    await this.sqs.send(
                        new SendMessageCommand({
                            QueueUrl: queueUrl,
                            MessageBody: JSON.stringify(msg.payload),
                            MessageGroupId: msg.aggregateId,
                            MessageDeduplicationId: msg.id,
                        }),
                    );
                    msg.markPublished(new Date());
                    await outbox.save(msg);
                    published++;
                } catch (err) {
                    msg.scheduleRetry(new Date());
                    await outbox.save(msg);
                    this.metrics?.recordRetry("outbox");
                    this.logger?.error("outbox_publish_failed", {
                        outboxId: msg.id,
                        eventType: msg.eventType,
                        attempts: msg.attempts,
                        reason: err instanceof Error ? err.name : "unknown",
                    });
                }
            }

            return published;
        });
    }
}