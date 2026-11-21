import { Injectable } from "@nestjs/common";

export interface OutboxLagMetric {
    pendingCount: number;
    oldestPendingAgeMs: number;
}

const MAX_LATENCY_SAMPLES = 1000;

@Injectable()
export class MetricsService {
    private transactionsByStatus: Record<string, number> = {
        PROCESSED: 0,
        REJECTED: 0,
        PENDING_REFERENCE: 0,
        FAILED: 0,
    };
    private duplicatesDetected = 0;
    private retriesBySource: Record<"sqs" | "outbox", number> = { sqs: 0, outbox: 0 };
    private dlqMessages = 0;
    private conflictsByType: Record<"lock" | "idempotency" | "unique", number> = {
        lock: 0,
        idempotency: 0,
        unique: 0,
    };
    private reconciliationDivergences = 0;
    private latencyCount = 0;
    private latencySumMs = 0;
    private latencySamples: number[] = [];

    recordTransaction(status: string, durationMs: number, idempotentReplay: boolean): void {
        if (idempotentReplay) {
            this.duplicatesDetected++;
        } else {
            this.transactionsByStatus[status] = (this.transactionsByStatus[status] ?? 0) + 1;
        }

        this.latencyCount++;
        this.latencySumMs += durationMs;
        this.latencySamples.push(durationMs);
        if (this.latencySamples.length > MAX_LATENCY_SAMPLES) {
            this.latencySamples.shift();
        }
    }

    recordRetry(source: "sqs" | "outbox"): void {
        this.retriesBySource[source]++;
    }

    recordDlq(): void {
        this.dlqMessages++;
    }

    recordConflict(type: "lock" | "idempotency" | "unique"): void {
        this.conflictsByType[type]++;
    }

    recordReconciliationDivergence(): void {
        this.reconciliationDivergences++;
    }

    snapshot(outboxLag: OutboxLagMetric) {
        const sorted = [...this.latencySamples].sort((a, b) => a - b);
        const percentile = (p: number) => {
            if (sorted.length === 0) return 0;
            const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
            return Number((sorted[idx] ?? 0).toFixed(2));
        };

        return {
            transactionsByStatus: { ...this.transactionsByStatus },
            duplicatesDetected: this.duplicatesDetected,
            retries: {
                total: this.retriesBySource.sqs + this.retriesBySource.outbox,
                ...this.retriesBySource,
            },
            dlqMessages: this.dlqMessages,
            conflicts: {
                total:
                    this.conflictsByType.lock +
                    this.conflictsByType.idempotency +
                    this.conflictsByType.unique,
                ...this.conflictsByType,
            },
            reconciliationDivergences: this.reconciliationDivergences,
            outboxLag,
            processingLatencyMs: {
                count: this.latencyCount,
                avg:
                    this.latencyCount === 0
                        ? 0
                        : Number((this.latencySumMs / this.latencyCount).toFixed(2)),
                p50: percentile(50),
                p95: percentile(95),
            },
        };
    }
}