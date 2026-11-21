import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { CreateWalletUseCase } from "../../src/application/use-cases/create_wallet.use_case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process_wager_transaction.use_case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile_wallet.use_case";
import { MikroOrmUnitOfWork } from "../../src/database/repositories/unit_of_work";
import { DomainError } from "../../src/domain/shared/domain-error";
import {
    FailureCode,
    WagerTransactionKind,
    WagerTransactionStatus,
} from "../../src/domain/wager/wager_transaction";
import { LedgerDirection } from "../../src/domain/wallet/wallet_ledger_entry";

describe("Wager Processing & Concurrency Integration (PostgreSQL)", () => {
    let orm: MikroORM;
    let uow: MikroOrmUnitOfWork;
    let createWallet: CreateWalletUseCase;
    let processWager: ProcessWagerTransactionUseCase;
    let reconcileWallet: ReconcileWalletUseCase;

    beforeAll(async () => {
        orm = await MikroORM.init(config);
        await orm.migrator.up();
        uow = new MikroOrmUnitOfWork(orm.em);
        createWallet = new CreateWalletUseCase(uow);
        processWager = new ProcessWagerTransactionUseCase(uow);
        reconcileWallet = new ReconcileWalletUseCase(uow);
    });

    beforeEach(async () => {
        await orm.em
            .fork()
            .execute(
                "TRUNCATE TABLE outbox_messages, inbox_messages, wager_transactions, wallet_ledger_entries, wallets CASCADE",
            );
    });

    afterAll(async () => {
        await orm.close(true);
    });

    it("50 apostas idênticas em paralelo produzem exatamente 1 débito e 49 replays idempotentes", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "1000.00", currency: "BRL" },
        });

        const request = {
            idempotencyKey: "provider-a:bet-50x",
            providerId: "provider-a",
            externalTransactionId: "bet-50x",
            playerId,
            walletId: wallet.id,
            roundId: "round-1",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Bet,
            money: { amount: "25.00", currency: "BRL" },
        };

        const results = await Promise.all(
            Array.from({ length: 50 }, () => processWager.execute(request)),
        );

        const fresh = results.filter((r) => !r.idempotentReplay);
        const replays = results.filter((r) => r.idempotentReplay);

        expect(fresh).toHaveLength(1);
        expect(replays).toHaveLength(49);
        for (const r of results) {
            expect(r.status).toBe(WagerTransactionStatus.Processed);
            expect(r.balance).toEqual({ amount: "975.00", currency: "BRL" });
            expect(r.transactionId).toBe(fresh[0]!.transactionId);
        }

        const report = await reconcileWallet.execute(wallet.id);
        expect(report.consistent).toBe(true);
        expect(report.storedBalance.amount).toBe("975.00");
        expect(report.checkedEntries).toBe(2); // 1 OPENING + 1 BET
    });

    it("cenário obrigatório: saldo 100.00 + duas apostas simultâneas de 80.00 → 1 PROCESSED, 1 REJECTED, saldo 20.00", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "100.00", currency: "BRL" },
        });

        const [r1, r2] = await Promise.all([
            processWager.execute({
                idempotencyKey: "provider-a:race-1",
                providerId: "provider-a",
                externalTransactionId: "race-1",
                playerId,
                walletId: wallet.id,
                roundId: "round-race",
                gameId: "fortune-chimp",
                kind: WagerTransactionKind.Bet,
                money: { amount: "80.00", currency: "BRL" },
            }),
            processWager.execute({
                idempotencyKey: "provider-a:race-2",
                providerId: "provider-a",
                externalTransactionId: "race-2",
                playerId,
                walletId: wallet.id,
                roundId: "round-race",
                gameId: "fortune-chimp",
                kind: WagerTransactionKind.Bet,
                money: { amount: "80.00", currency: "BRL" },
            }),
        ]);

        const processed = [r1, r2].filter((r) => r.status === WagerTransactionStatus.Processed);
        const rejected = [r1, r2].filter((r) => r.status === WagerTransactionStatus.Rejected);

        expect(processed).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.failureCode).toBe(FailureCode.InsufficientFunds);

        await uow.run(async ({ wallets }) => {
            const page = await wallets.listLedgerEntries({ walletId: wallet.id, limit: 10 });
            const debits = page.items.filter((e) => e.direction === LedgerDirection.Debit);
            expect(debits).toHaveLength(1);
        });

        const report = await reconcileWallet.execute(wallet.id);
        expect(report.consistent).toBe(true);
        expect(report.storedBalance.amount).toBe("20.00");
    });

    it("detecta IDEMPOTENCY_CONFLICT quando payload diverge e preserva saldo original no replay de LOSS", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "100.00", currency: "BRL" },
        });

        const lossInput = {
            idempotencyKey: "provider-a:loss-1",
            providerId: "provider-a",
            externalTransactionId: "loss-1",
            playerId,
            walletId: wallet.id,
            roundId: "round-1",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Loss,
            money: { amount: "10.00", currency: "BRL" },
        };

        const loss1 = await processWager.execute(lossInput);
        expect(loss1.status).toBe(WagerTransactionStatus.Processed);
        expect(loss1.balance.amount).toBe("100.00");

        // Nova aposta reduz o saldo para 70.00
        await processWager.execute({
            idempotencyKey: "provider-a:bet-after-loss",
            providerId: "provider-a",
            externalTransactionId: "bet-after-loss",
            playerId,
            walletId: wallet.id,
            roundId: "round-2",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Bet,
            money: { amount: "30.00", currency: "BRL" },
        });

        // Replay do LOSS devolve o saldo observado naquele momento (100.00), não o atual (70.00)
        const lossReplay = await processWager.execute(lossInput);
        expect(lossReplay.idempotentReplay).toBe(true);
        expect(lossReplay.balance.amount).toBe("100.00");

        // Mesma idempotencyKey com payload divergente → IDEMPOTENCY_CONFLICT
        let errCode: string | undefined;
        try {
            await processWager.execute({
                ...lossInput,
                money: { amount: "99.00", currency: "BRL" },
            });
        } catch (err) {
            if (err instanceof DomainError) errCode = err.code;
        }
        expect(errCode).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("aplica regras de REFUND (sem duplicar), ROLLBACK com saldo insuficiente distinto e PENDING_REFERENCE", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "100.00", currency: "BRL" },
        });

        // 1. REFUND chegando ANTES da BET → PENDING_REFERENCE
        const orphanRefund = await processWager.execute({
            idempotencyKey: "provider-a:orphan-refund",
            providerId: "provider-a",
            externalTransactionId: "orphan-refund",
            playerId,
            walletId: wallet.id,
            roundId: "round-orphan",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Refund,
            money: { amount: "15.00", currency: "BRL" },
            referenceExternalTransactionId: "bet-not-arrived-yet",
        });
        expect(orphanRefund.status).toBe(WagerTransactionStatus.PendingReference);

        // 2. BET → REFUND válido → segundo REFUND rejeitado (REFERENCE_ALREADY_SETTLED)
        await processWager.execute({
            idempotencyKey: "provider-a:bet-1",
            providerId: "provider-a",
            externalTransactionId: "bet-1",
            playerId,
            walletId: wallet.id,
            roundId: "round-1",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Bet,
            money: { amount: "40.00", currency: "BRL" },
        });

        const refund1 = await processWager.execute({
            idempotencyKey: "provider-a:ref-1",
            providerId: "provider-a",
            externalTransactionId: "ref-1",
            playerId,
            walletId: wallet.id,
            roundId: "round-1",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Refund,
            money: { amount: "40.00", currency: "BRL" },
            referenceExternalTransactionId: "bet-1",
        });
        expect(refund1.status).toBe(WagerTransactionStatus.Processed);
        expect(refund1.balance.amount).toBe("100.00");

        const refund2 = await processWager.execute({
            idempotencyKey: "provider-a:ref-2",
            providerId: "provider-a",
            externalTransactionId: "ref-2",
            playerId,
            walletId: wallet.id,
            roundId: "round-1",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Refund,
            money: { amount: "40.00", currency: "BRL" },
            referenceExternalTransactionId: "bet-1",
        });
        expect(refund2.status).toBe(WagerTransactionStatus.Rejected);
        expect(refund2.failureCode).toBe(FailureCode.ReferenceAlreadySettled);

        // 3. WIN de 50 (saldo 150) → BET de 120 (saldo 30) → ROLLBACK do WIN de 50 rejeitado com REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE
        await processWager.execute({
            idempotencyKey: "provider-a:win-1",
            providerId: "provider-a",
            externalTransactionId: "win-1",
            playerId,
            walletId: wallet.id,
            roundId: "round-2",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Win,
            money: { amount: "50.00", currency: "BRL" },
        });
        await processWager.execute({
            idempotencyKey: "provider-a:bet-2",
            providerId: "provider-a",
            externalTransactionId: "bet-2",
            playerId,
            walletId: wallet.id,
            roundId: "round-3",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Bet,
            money: { amount: "120.00", currency: "BRL" },
        });

        const rollback = await processWager.execute({
            idempotencyKey: "provider-a:rb-win-1",
            providerId: "provider-a",
            externalTransactionId: "rb-win-1",
            playerId,
            walletId: wallet.id,
            roundId: "round-2",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Rollback,
            money: { amount: "50.00", currency: "BRL" },
            referenceExternalTransactionId: "win-1",
        });
        expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
        expect(rollback.failureCode).toBe(FailureCode.ReversalWouldCauseNegativeBalance);

        const report = await reconcileWallet.execute(wallet.id);
        expect(report.consistent).toBe(true);
        expect(report.storedBalance.amount).toBe("30.00");
    });
});