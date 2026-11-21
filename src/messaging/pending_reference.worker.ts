import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import {
    WAGER_STRATEGIES,
    applyWagerDecision,
    type ExternalWagerKind,
    type WagerDecision,
} from "../application/wager_strategies";
import { FailureCode, WagerTransactionKind } from "../domain/wager/wager_transaction";
import { UNIT_OF_WORK, type UnitOfWork } from "../ports/unit_of_work.port";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private stopping = false;
    private inFlight: Promise<unknown> = Promise.resolve();

    constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

    onModuleInit(): void {
        if (process.env.WORKERS_ENABLED === "false") return;
        const intervalMs = Number(process.env.PENDING_REF_POLL_MS ?? 2000);
        const ttlMs = Number(process.env.PENDING_REF_TTL_MS ?? 30_000);

        this.timer = setInterval(() => {
            if (this.running || this.stopping) return;
            this.running = true;
            this.inFlight = this.processBatchOnce(20, ttlMs)
                .catch((err) => {
                    console.error(
                        JSON.stringify({
                            level: "error",
                            event: "pending_reference_poll_error",
                            message: err instanceof Error ? err.message : String(err),
                        }),
                    );
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
        return this.uow.run(async (repos) => {
            const pendingList = await repos.wagerTransactions.findPendingReferences(limit);
            let resolved = 0;

            for (const tx of pendingList) {
                if (tx.kind === WagerTransactionKind.Opening) continue;

                const wallet = await repos.wallets.findByIdForUpdate(tx.walletId);
                if (!wallet) continue;

                const kind = tx.kind as ExternalWagerKind;
                let decision: WagerDecision = await WAGER_STRATEGIES[kind].evaluate({
                    repos,
                    wallet,
                    tx,
                });

                if (decision.outcome === "PENDING_REFERENCE") {
                    const expired = now.getTime() - tx.createdAt.getTime() >= ttlMs;
                    if (!expired) continue;
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
                resolved++;
            }

            return resolved;
        });
    }
}