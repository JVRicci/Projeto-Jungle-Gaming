import {
    Inject,
    Injectable,
    Optional,
    type OnModuleDestroy,
    type OnModuleInit,
} from "@nestjs/common";
import {
    WAGER_STRATEGIES,
    applyWagerDecision,
    type ExternalWagerKind,
    type WagerDecision,
} from "../application/wager_strategies";
import { FailureCode } from "../domain/wager/wager_transaction";
import { StructuredLogger } from "../observability/structured_logger";
import { UNIT_OF_WORK, type UnitOfWork } from "../ports/unit_of_work.port";

/** Backoff exponencial: 1s, 2s, 4s, 8s, 15s (teto menor que o TTL padrão de 30s). */
export function pendingReferenceBackoffMs(attempts: number, baseMs = 1000, maxMs = 15_000): number {
    return Math.min(baseMs * 2 ** attempts, maxMs);
}

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private stopping = false;
    private inFlight: Promise<unknown> = Promise.resolve();

    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Optional() private readonly logger?: StructuredLogger,
    ) {}

    onModuleInit(): void {
        if (process.env.WORKERS_ENABLED === "false") return;
        const intervalMs = Number(process.env.PENDING_REF_POLL_MS ?? 2000);
        const ttlMs = Number(process.env.PENDING_REF_TTL_MS ?? 30_000);

        this.timer = setInterval(() => {
            if (this.running || this.stopping) return;
            this.running = true;
            this.inFlight = this.processBatchOnce(20, ttlMs)
                .catch((err) => {
                    this.logger?.error("pending_reference_poll_error", {
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

    async processBatchOnce(limit = 20, ttlMs = 30_000, now: Date = new Date()): Promise<number> {
        // Fase 1: lê candidatas sem lock
        const candidates = await this.uow.run(({ wagerTransactions }) =>
            wagerTransactions.findDuePendingReferences(now, limit),
        );

        // Fase 2: 1 transação SQL por item, travando wallet primeiro (mesma ordem do HTTP/SQS)
        let resolved = 0;
        for (const { transaction } of candidates) {
            try {
                if (await this.processOne(transaction.id, transaction.walletId, ttlMs, now)) {
                    resolved++;
                }
            } catch (err) {
                this.logger?.error("pending_reference_item_failed", {
                    transactionId: transaction.id,
                    walletId: transaction.walletId,
                    reason: err instanceof Error ? err.name : "unknown",
                });
            }
        }
        return resolved;
    }

    private processOne(
        txId: string,
        walletId: string,
        ttlMs: number,
        now: Date,
    ): Promise<boolean> {
        return this.uow.run(async (repos) => {
            const wallet = await repos.wallets.findByIdForUpdate(walletId);
            if (!wallet) return false;

            const item = await repos.wagerTransactions.findPendingReferenceById(txId);
            if (!item) return false;

            const tx = item.transaction;
            let decision: WagerDecision = await WAGER_STRATEGIES[
                tx.kind as ExternalWagerKind
            ].evaluate({ repos, wallet, tx });

            if (decision.outcome === "PENDING_REFERENCE") {
                const expired = now.getTime() - tx.createdAt.getTime() >= ttlMs;
                if (!expired) {
                    const delay = pendingReferenceBackoffMs(item.referenceAttempts);
                    await repos.wagerTransactions.scheduleReferenceRetry(
                        tx.id,
                        item.referenceAttempts + 1,
                        new Date(now.getTime() + delay),
                    );
                    return false;
                }
                decision = { outcome: "REJECT", failureCode: FailureCode.ReferenceTtlExpired };
            }

            await applyWagerDecision({
                repos,
                wallet,
                tx,
                decision,
                isNew: false,
                correlationId: crypto.randomUUID(),
                now,
            });
            return true;
        });
    }
}