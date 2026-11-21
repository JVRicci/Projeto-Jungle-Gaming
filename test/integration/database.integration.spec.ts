import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/database/repositories/unit_of_work";
import { WalletBalanceChanged } from "../../src/domain/events/wallet_balance_changed";
import { InboxMessage } from "../../src/domain/messages/inbox";
import { OutboxMessage } from "../../src/domain/messages/outbox";
import { Money } from "../../src/domain/money/money";
import {
    FailureCode,
    WagerTransaction,
    WagerTransactionKind,
} from "../../src/domain/wager/wager_transaction";
import { Wallet } from "../../src/domain/wallet/wallet";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Database Integration (PostgreSQL + MikroORM)", () => {
    let orm: MikroORM;
    let uow: MikroOrmUnitOfWork;

    beforeAll(async () => {
        orm = await MikroORM.init(config);
        await orm.migrator.up();
        uow = new MikroOrmUnitOfWork(orm.em);
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

    it("persiste wallet, ledger, wager (com observedBalance), inbox e outbox + paginação e reconciliação", async () => {
        const walletId = crypto.randomUUID();
        const playerId = crypto.randomUUID();
        const openingTxId = crypto.randomUUID();
        const betTxId = crypto.randomUUID();
        const t1 = new Date("2026-11-20T12:00:00.000Z");
        const t2 = new Date("2026-11-20T12:01:00.000Z");

        await uow.run(async ({ wallets, wagerTransactions, inbox, outbox }) => {
            const wallet = Wallet.open({
                id: walletId,
                playerId,
                initialBalance: Money.zero("BRL"),
            });
            await wallets.create(wallet);

            // 1. Crédito de abertura
            const openingEntry = wallet.credit({
                ledgerEntryId: crypto.randomUUID(),
                transactionId: openingTxId,
                money: brl("100.00"),
                at: t1,
            });
            await wallets.save(wallet);
            await wallets.appendLedgerEntry(openingEntry);

            // 2. Aposta BET de 25.00
            const lockedWallet = await wallets.findByIdForUpdate(walletId);
            expect(lockedWallet).not.toBeNull();

            const betEntry = lockedWallet!.debit({
                ledgerEntryId: crypto.randomUUID(),
                transactionId: betTxId,
                money: brl("25.00"),
                at: t2,
            });
            await wallets.save(lockedWallet!);
            await wallets.appendLedgerEntry(betEntry);

            const betTx = WagerTransaction.create({
                id: betTxId,
                providerId: "provider-a",
                externalTransactionId: "ext-bet-1",
                idempotencyKey: "provider-a:ext-bet-1",
                payloadHash: "a".repeat(64),
                walletId,
                playerId,
                roundId: "round-1",
                gameId: "fortune-chimp",
                kind: WagerTransactionKind.Bet,
                money: brl("25.00"),
                createdAt: t2,
            });
            betTx.markProcessed(undefined, t2);
            await wagerTransactions.create(betTx, lockedWallet!.balance.toJSON().amount);

            const inboxMsg = InboxMessage.receive({
                consumerName: "wager-consumer",
                messageId: "msg-1",
                payloadHash: "a".repeat(64),
                receivedAt: t2,
            });
            inboxMsg.markProcessed(t2);
            await inbox.create(inboxMsg);

            const event = WalletBalanceChanged.from({
                wallet: lockedWallet!,
                entry: betEntry,
                context: { correlationId: "corr-1" },
            });
            await outbox.enqueue(OutboxMessage.enqueue(event));
        });

        // Verificação fora da transação de escrita
        await uow.run(async ({ wallets, wagerTransactions, inbox, outbox }) => {
            const storedWallet = await wallets.findById(walletId);
            expect(storedWallet?.balance.toJSON().amount).toBe("75.00");
            expect(storedWallet?.version).toBe(3);

            const summary = await wallets.calculateBalanceFromLedger(walletId);
            expect(summary).toEqual({ calculatedAmount: "75.00", checkedEntries: 2 });

            // Paginação por cursor (2 páginas de 1 item)
            const page1 = await wallets.listLedgerEntries({ walletId, limit: 1 });
            expect(page1.items).toHaveLength(1);
            expect(page1.items[0]?.transactionId).toBe(betTxId);
            expect(page1.nextCursor).not.toBeNull();

            const page2 = await wallets.listLedgerEntries({
                walletId,
                cursor: page1.nextCursor!,
                limit: 1,
            });
            expect(page2.items).toHaveLength(1);
            expect(page2.items[0]?.transactionId).toBe(openingTxId);
            expect(page2.nextCursor).toBeNull();

            const storedTx = await wagerTransactions.findByIdempotencyKey("provider-a:ext-bet-1");
            expect(storedTx?.observedBalance).toBe("75.00");

            const storedInbox = await inbox.findByKey("wager-consumer", "msg-1");
            expect(storedInbox?.isProcessed()).toBe(true);

            const pendingOutbox = await outbox.claimPendingBatch(new Date("2026-11-20T12:02:00.000Z"), 10);
            expect(pendingOutbox).toHaveLength(1);
            expect(pendingOutbox[0]?.eventType).toBe("WalletBalanceChanged");
        });
    });

    it("faz rollback atômico em todas as tabelas se ocorrer erro no meio da UnitOfWork", async () => {
        const walletId = crypto.randomUUID();

        await expect(
            uow.run(async ({ wallets, inbox }) => {
                const wallet = Wallet.open({
                    id: walletId,
                    playerId: crypto.randomUUID(),
                    initialBalance: brl("50.00"),
                });
                await wallets.create(wallet);

                await inbox.create(
                    InboxMessage.receive({
                        consumerName: "wager-consumer",
                        messageId: "msg-rollback",
                        payloadHash: "b".repeat(64),
                    }),
                );

                throw new Error("FALHA_SIMULADA_NO_MEIO_DA_TX");
            }),
        ).rejects.toThrow("FALHA_SIMULADA_NO_MEIO_DA_TX");

        await uow.run(async ({ wallets, inbox }) => {
            expect(await wallets.findById(walletId)).toBeNull();
            expect(await inbox.findByKey("wager-consumer", "msg-rollback")).toBeNull();
        });
    });

    it("bloqueia UPDATE e DELETE no ledger pela trigger trg_ledger_immutable", async () => {
        const walletId = crypto.randomUUID();
        const entryId = crypto.randomUUID();

        await uow.run(async ({ wallets }) => {
            const wallet = Wallet.open({
                id: walletId,
                playerId: crypto.randomUUID(),
                initialBalance: Money.zero("BRL"),
            });
            await wallets.create(wallet);
            const entry = wallet.credit({
                ledgerEntryId: entryId,
                transactionId: crypto.randomUUID(),
                money: brl("10.00"),
            });
            await wallets.save(wallet);
            await wallets.appendLedgerEntry(entry);
        });

        await expect(
            orm.em.fork().execute("UPDATE wallet_ledger_entries SET amount = 999 WHERE id = ?", [entryId]),
        ).rejects.toThrow(/imutáveis/i);

        await expect(
            orm.em.fork().execute("DELETE FROM wallet_ledger_entries WHERE id = ?", [entryId]),
        ).rejects.toThrow(/imutáveis/i);
    });

    it("aplica constraints de banco: saldo negativo, wallet duplicada e reversão única PROCESSED", async () => {
        const walletId = crypto.randomUUID();
        const playerId = crypto.randomUUID();
        const betTxId = crypto.randomUUID();

        await uow.run(async ({ wallets, wagerTransactions }) => {
            const wallet = Wallet.open({
                id: walletId,
                playerId,
                initialBalance: brl("100.00"),
            });
            await wallets.create(wallet);

            const bet = WagerTransaction.create({
                id: betTxId,
                providerId: "provider-a",
                externalTransactionId: "ext-bet-1",
                idempotencyKey: "provider-a:ext-bet-1",
                payloadHash: "c".repeat(64),
                walletId,
                playerId,
                roundId: "round-1",
                gameId: "game-1",
                kind: WagerTransactionKind.Bet,
                money: brl("20.00"),
            });
            bet.markProcessed(undefined, new Date());
            await wagerTransactions.create(bet, "80.00");

            const refund1 = WagerTransaction.create({
                id: crypto.randomUUID(),
                providerId: "provider-a",
                externalTransactionId: "ext-ref-1",
                idempotencyKey: "provider-a:ext-ref-1",
                payloadHash: "d".repeat(64),
                walletId,
                playerId,
                roundId: "round-1",
                gameId: "game-1",
                kind: WagerTransactionKind.Refund,
                money: brl("20.00"),
                referenceExternalTransactionId: "ext-bet-1",
            });
            refund1.markProcessed(betTxId, new Date());
            await wagerTransactions.create(refund1, "100.00");
        });

        // 1. Wallet duplicada para mesmo (playerId, currency)
        await expect(
            uow.run(async ({ wallets }) => {
                await wallets.create(
                    Wallet.open({
                        id: crypto.randomUUID(),
                        playerId,
                        initialBalance: brl("10.00"),
                    }),
                );
            }),
        ).rejects.toThrow();

        // 2. Saldo negativo (CHECK balance >= 0)
        await expect(
            orm.em.fork().execute("UPDATE wallets SET balance = -1.00 WHERE id = ?", [walletId]),
        ).rejects.toThrow();

        // 3. Segundo REFUND PROCESSED para a mesma referência deve falhar (uq_wager_single_reversal)
        await expect(
            uow.run(async ({ wagerTransactions }) => {
                const refund2 = WagerTransaction.create({
                    id: crypto.randomUUID(),
                    providerId: "provider-a",
                    externalTransactionId: "ext-ref-2",
                    idempotencyKey: "provider-a:ext-ref-2",
                    payloadHash: "e".repeat(64),
                    walletId,
                    playerId,
                    roundId: "round-1",
                    gameId: "game-1",
                    kind: WagerTransactionKind.Refund,
                    money: brl("20.00"),
                    referenceExternalTransactionId: "ext-bet-1",
                });
                refund2.markProcessed(betTxId, new Date());
                await wagerTransactions.create(refund2, "120.00");
            }),
        ).rejects.toThrow();

        // 4. Segundo REFUND gravado como REJECTED deve ser PERMITIDO (auditoria)
        await uow.run(async ({ wagerTransactions }) => {
            const refundRejected = WagerTransaction.create({
                id: crypto.randomUUID(),
                providerId: "provider-a",
                externalTransactionId: "ext-ref-3",
                idempotencyKey: "provider-a:ext-ref-3",
                payloadHash: "f".repeat(64),
                walletId,
                playerId,
                roundId: "round-1",
                gameId: "game-1",
                kind: WagerTransactionKind.Refund,
                money: brl("20.00"),
                referenceExternalTransactionId: "ext-bet-1",
            });
            refundRejected.reject(FailureCode.ReferenceAlreadySettled);
            await wagerTransactions.create(refundRejected, "100.00");
        });
    });

    it("dois publishers concorrentes não pegam o mesmo evento da outbox (FOR UPDATE SKIP LOCKED)", async () => {
        const walletId = crypto.randomUUID();
        const playerId = crypto.randomUUID();
        const now = new Date();

        await uow.run(async ({ wallets, outbox }) => {
            const wallet = Wallet.open({ id: walletId, playerId, initialBalance: Money.zero("BRL") });
            await wallets.create(wallet);

            for (let i = 0; i < 2; i++) {
                const entry = wallet.credit({
                    ledgerEntryId: crypto.randomUUID(),
                    transactionId: crypto.randomUUID(),
                    money: brl("10.00"),
                    at: new Date(now.getTime() + i * 1000),
                });
                await wallets.save(wallet);
                await wallets.appendLedgerEntry(entry);

                const event = WalletBalanceChanged.from({
                    wallet,
                    entry,
                    context: { correlationId: `corr-${i}` },
                });
                await outbox.enqueue(OutboxMessage.enqueue(event));
            }
        });

        const claimDate = new Date(now.getTime() + 5000);
        const [batch1, batch2] = await Promise.all([
            uow.run(async ({ outbox }) => {
                const batch = await outbox.claimPendingBatch(claimDate, 1);
                await Bun.sleep(150);
                return batch.map((m) => m.id);
            }),
            uow.run(async ({ outbox }) => {
                await Bun.sleep(30);
                const batch = await outbox.claimPendingBatch(claimDate, 1);
                return batch.map((m) => m.id);
            }),
        ]);

        expect(batch1).toHaveLength(1);
        expect(batch2).toHaveLength(1);
        expect(batch1[0]).not.toBe(batch2[0]);
    });
});