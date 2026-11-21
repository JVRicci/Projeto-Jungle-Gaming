import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { CreateWalletUseCase } from "../../src/application/use-cases/create_wallet.use_case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile_wallet.use_case";
import { MikroOrmUnitOfWork } from "../../src/database/repositories/unit_of_work";
import { DomainError } from "../../src/domain/shared/domain-error";
import { WagerTransactionKind } from "../../src/domain/wager/wager_transaction";
import { LedgerDirection } from "../../src/domain/wallet/wallet_ledger_entry";

async function domainErrorCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
    try {
        await fn();
    } catch (err) {
        if (err instanceof DomainError) return err.code;
        throw err;
    }
    return undefined;
}

describe("Wallet Use Cases Integration (PostgreSQL)", () => {
    let orm: MikroORM;
    let uow: MikroOrmUnitOfWork;
    let createWallet: CreateWalletUseCase;
    let reconcileWallet: ReconcileWalletUseCase;

    beforeAll(async () => {
        orm = await MikroORM.init(config);
        await orm.migrator.up();
        uow = new MikroOrmUnitOfWork(orm.em);
        createWallet = new CreateWalletUseCase(uow);
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

    it("cria wallet com saldo inicial > 0 gerando OPENING, CREDIT no ledger, eventos na outbox e version 1", async () => {
        const playerId = crypto.randomUUID();
        const created = await createWallet.execute({
            playerId,
            initialBalance: { amount: "1000.00", currency: "BRL" },
        });

        expect(created.playerId).toBe(playerId);
        expect(created.balance).toEqual({ amount: "1000.00", currency: "BRL" });
        expect(created.version).toBe(1);

        await uow.run(async ({ wallets, wagerTransactions, outbox }) => {
            const page = await wallets.listLedgerEntries({ walletId: created.id, limit: 10 });
            expect(page.items).toHaveLength(1);
            expect(page.items[0]?.direction).toBe(LedgerDirection.Credit);
            expect(page.items[0]?.money.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
            expect(page.items[0]?.balanceBefore.toJSON().amount).toBe("0.00");
            expect(page.items[0]?.balanceAfter.toJSON().amount).toBe("1000.00");

            const opening = await wagerTransactions.findByIdempotencyKey(
                `internal:opening:${created.id}`,
            );
            expect(opening?.transaction.kind).toBe(WagerTransactionKind.Opening);
            expect(opening?.observedBalance).toBe("1000.00");

            const events = await outbox.claimPendingBatch(new Date(Date.now() + 5000), 10);
            expect(events.map((e) => e.eventType).sort()).toEqual([
                "WagerTransactionProcessed",
                "WalletBalanceChanged",
            ]);
        });
    });

    it("cria wallet com saldo inicial 0.00 sem gerar OPENING, ledger ou eventos", async () => {
        const created = await createWallet.execute({
            playerId: crypto.randomUUID(),
            initialBalance: { amount: "0.00", currency: "BRL" },
        });

        expect(created.balance).toEqual({ amount: "0.00", currency: "BRL" });
        expect(created.version).toBe(1);

        await uow.run(async ({ wallets, outbox }) => {
            const page = await wallets.listLedgerEntries({ walletId: created.id, limit: 10 });
            expect(page.items).toHaveLength(0);

            const events = await outbox.claimPendingBatch(new Date(Date.now() + 5000), 10);
            expect(events).toHaveLength(0);
        });
    });

    it("falha com WALLET_ALREADY_EXISTS ao duplicar (playerId, currency), inclusive em paralelo", async () => {
        const playerId = crypto.randomUUID();
        const input = { playerId, initialBalance: { amount: "100.00", currency: "BRL" } };

        const results = await Promise.allSettled([
            createWallet.execute(input),
            createWallet.execute(input),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DomainError);
        expect(((rejected[0] as PromiseRejectedResult).reason as DomainError).code).toBe(
            "WALLET_ALREADY_EXISTS",
        );
    });

    it("reconcilia wallet consistente retornando difference 0.00 e consistent true", async () => {
        const created = await createWallet.execute({
            playerId: crypto.randomUUID(),
            initialBalance: { amount: "250.00", currency: "BRL" },
        });

        const report = await reconcileWallet.execute(created.id);

        expect(report).toEqual({
            walletId: created.id,
            storedBalance: { amount: "250.00", currency: "BRL" },
            calculatedBalance: { amount: "250.00", currency: "BRL" },
            difference: { amount: "0.00", currency: "BRL" },
            consistent: true,
            checkedEntries: 1,
        });
    });

    it("detecta divergência na reconciliação sem corrigir silenciosamente o saldo", async () => {
        const created = await createWallet.execute({
            playerId: crypto.randomUUID(),
            initialBalance: { amount: "1000.00", currency: "BRL" },
        });

        // Simula corrupção direta no saldo materializado
        await orm.em
            .fork()
            .execute("UPDATE wallets SET balance = 999.00 WHERE id = ?", [created.id]);

        const report = await reconcileWallet.execute(created.id);

        expect(report.consistent).toBe(false);
        expect(report.storedBalance).toEqual({ amount: "999.00", currency: "BRL" });
        expect(report.calculatedBalance).toEqual({ amount: "1000.00", currency: "BRL" });
        expect(report.difference).toEqual({ amount: "-1.00", currency: "BRL" });
        expect(report.checkedEntries).toBe(1);

        // Garante que NÃO corrigiu silenciosamente no banco
        await uow.run(async ({ wallets }) => {
            const after = await wallets.findById(created.id);
            expect(after?.balance.toJSON().amount).toBe("999.00");
        });
    });

    it("lança WALLET_NOT_FOUND ao reconciliar wallet inexistente", async () => {
        const code = await domainErrorCodeOf(() =>
            reconcileWallet.execute(crypto.randomUUID()),
        );
        expect(code).toBe("WALLET_NOT_FOUND");
    });
});