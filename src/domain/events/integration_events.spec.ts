import { describe, expect, it } from "bun:test";
import { OutboxMessage } from "../messages/outbox";
import { Money } from "../money/money";
import { FailureCode, WagerTransaction, WagerTransactionKind } from "../wager/wager_transaction";
import { Wallet } from "../wallet/wallet";
import { LedgerDirection } from "../wallet/wallet_ledger_entry";
import { WagerTransactionPendingReference } from "./wager_transaction_pending_reference";
import { WagerTransactionProcessed } from "./wager_transaction_processed";
import { WagerTransactionRejected } from "./wager_transaction_rejected";
import { WalletBalanceChanged } from "./wallet_balance_changed";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const context = { correlationId: "corr-1", causationId: "cause-1" };
const at = new Date("2026-11-21T12:00:00.000Z");

function makeTx(kind: WagerTransactionKind, referenceExternalTransactionId?: string) {
    return WagerTransaction.create({
        id: "tx-1",
        providerId: "provider-a",
        externalTransactionId: "ext-1",
        idempotencyKey: "provider-a:ext-1",
        payloadHash: "a".repeat(64),
        walletId: "w-1",
        playerId: "p-1",
        roundId: "round-1",
        gameId: "game-1",
        kind,
        money: brl("25.00"),
        referenceExternalTransactionId,
        createdAt: at,
    });
}

describe("IntegrationEvents", () => {
    it("WalletBalanceChanged serializa envelope completo, MoneyProps como string e vira OutboxMessage", () => {
        const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: brl("100.00") });
        const entry = wallet.debit({
            ledgerEntryId: "l-1",
            transactionId: "tx-1",
            money: brl("25.00"),
            at,
        });
        const event = WalletBalanceChanged.from({ wallet, entry, context });
        const json = event.toJSON();

        expect(json.eventType).toBe("WalletBalanceChanged");
        expect(json.version).toBe(1);
        expect(json.aggregateId).toBe("w-1");
        expect(json.correlationId).toBe("corr-1");
        expect(json.causationId).toBe("cause-1");
        expect(json.occurredAt).toBe(at.toISOString());
        expect(json.data.direction).toBe(LedgerDirection.Debit);
        expect(json.data.money).toEqual({ amount: "25.00", currency: "BRL" });
        expect(json.data.balanceBefore).toEqual({ amount: "100.00", currency: "BRL" });
        expect(json.data.balanceAfter).toEqual({ amount: "75.00", currency: "BRL" });
        expect(json.data.walletVersion).toBe(2);
        expect(Object.isFrozen(event.data)).toBe(true);

        const outbox = OutboxMessage.enqueue(event);
        expect(outbox.id).toBe(event.eventId);
        expect(outbox.eventType).toBe("WalletBalanceChanged");
        expect(outbox.payload).toEqual(JSON.parse(JSON.stringify(json)));
    });

    it("WagerTransactionProcessed, Rejected e PendingReference carregam metadados e códigos corretos", () => {
        const processed = makeTx(WagerTransactionKind.Bet);
        processed.markProcessed(undefined, at);
        const pJson = WagerTransactionProcessed.from({ transaction: processed, context }).toJSON();
        expect(pJson.eventType).toBe("WagerTransactionProcessed");
        expect(pJson.aggregateId).toBe("tx-1");
        expect(pJson.occurredAt).toBe(at.toISOString());

        const rejected = makeTx(WagerTransactionKind.Bet);
        rejected.reject(FailureCode.InsufficientFunds, at);
        const rJson = WagerTransactionRejected.from({ transaction: rejected, context }).toJSON();
        expect(rJson.eventType).toBe("WagerTransactionRejected");
        expect(rJson.data.failureCode).toBe(FailureCode.InsufficientFunds);

        const pending = makeTx(WagerTransactionKind.Refund, "bet-1");
        pending.markPendingReference();
        const prJson = WagerTransactionPendingReference.from({
            transaction: pending,
            context,
        }).toJSON();
        expect(prJson.eventType).toBe("WagerTransactionPendingReference");
        expect(prJson.data.referenceExternalTransactionId).toBe("bet-1");
    });
});