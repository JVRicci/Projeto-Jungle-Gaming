import { WagerTransactionPendingReference } from "../domain/events/wager_transaction_pending_reference";
import { WagerTransactionProcessed } from "../domain/events/wager_transaction_processed";
import { WagerTransactionRejected } from "../domain/events/wager_transaction_rejected";
import { WalletBalanceChanged } from "../domain/events/wallet_balance_changed";
import { OutboxMessage } from "../domain/messages/outbox";
import type { MoneyProps } from "../domain/money/money";
import {
    FailureCode,
    WagerTransactionKind,
    type WagerTransaction,
    type WagerTransactionStatus,
} from "../domain/wager/wager_transaction";
import type { Wallet } from "../domain/wallet/wallet";
import { LedgerDirection } from "../domain/wallet/wallet_ledger_entry";
import type { TransactionalRepositories } from "../ports/unit_of_work.port";
import {
    isReferenceUnavailable,
    validateReversalReference,
    validateWinReference,
} from "./wager_rules";

export type ExternalWagerKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export type WagerDecision =
    | { outcome: "REJECT"; failureCode: FailureCode }
    | { outcome: "PENDING_REFERENCE" }
    | { outcome: "PROCESS_NO_BALANCE"; referenceTransactionId?: string }
    | { outcome: "PROCESS_WITH_BALANCE"; direction: LedgerDirection; referenceTransactionId?: string };

export interface WagerStrategyContext {
    repos: TransactionalRepositories;
    wallet: Wallet;
    tx: WagerTransaction;
}

export interface WagerKindStrategy {
    evaluate(ctx: WagerStrategyContext): Promise<WagerDecision>;
}

const betStrategy: WagerKindStrategy = {
    async evaluate({ wallet, tx }) {
        if (wallet.balance.isLessThan(tx.money)) {
            return { outcome: "REJECT", failureCode: FailureCode.InsufficientFunds };
        }
        return { outcome: "PROCESS_WITH_BALANCE", direction: LedgerDirection.Debit };
    },
};

const winStrategy: WagerKindStrategy = {
    async evaluate({ repos, tx }) {
        if (!tx.referenceExternalTransactionId) {
            return { outcome: "PROCESS_WITH_BALANCE", direction: LedgerDirection.Credit };
        }
        const storedRef = await repos.wagerTransactions.findByProviderExternalId(
            tx.providerId,
            tx.referenceExternalTransactionId,
        );
        if (isReferenceUnavailable(storedRef?.transaction)) {
            return { outcome: "PENDING_REFERENCE" };
        }
        const err = validateWinReference(tx, storedRef!.transaction);
        if (err) return { outcome: "REJECT", failureCode: err };
        return {
            outcome: "PROCESS_WITH_BALANCE",
            direction: LedgerDirection.Credit,
            referenceTransactionId: storedRef!.transaction.id,
        };
    },
};

const lossStrategy: WagerKindStrategy = {
    async evaluate() {
        return { outcome: "PROCESS_NO_BALANCE" };
    },
};

const reversalStrategy: WagerKindStrategy = {
    async evaluate({ repos, wallet, tx }) {
        const storedRef = await repos.wagerTransactions.findByProviderExternalId(
            tx.providerId,
            tx.referenceExternalTransactionId!,
        );
        if (isReferenceUnavailable(storedRef?.transaction)) {
            return { outcome: "PENDING_REFERENCE" };
        }

        const refTx = storedRef!.transaction;
        const alreadyReversed = await repos.wagerTransactions.hasProcessedReversal(
            refTx.id,
        );
        const refError = validateReversalReference(tx, refTx, alreadyReversed);
        if (refError) return { outcome: "REJECT", failureCode: refError };

        const direction = tx.ledgerDirectionFor(refTx);
        if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
            return {
                outcome: "REJECT",
                failureCode: FailureCode.ReversalWouldCauseNegativeBalance,
            };
        }

        return { outcome: "PROCESS_WITH_BALANCE", direction, referenceTransactionId: refTx.id };
    },
};

export const WAGER_STRATEGIES: Record<ExternalWagerKind, WagerKindStrategy> = {
    [WagerTransactionKind.Bet]: betStrategy,
    [WagerTransactionKind.Win]: winStrategy,
    [WagerTransactionKind.Loss]: lossStrategy,
    [WagerTransactionKind.Refund]: reversalStrategy,
    [WagerTransactionKind.Rollback]: reversalStrategy,
};

export interface AppliedWagerResult {
    transactionId: string;
    status: WagerTransactionStatus;
    balance: MoneyProps;
    idempotentReplay: boolean;
    failureCode?: FailureCode;
}

export async function applyWagerDecision(params: {
    repos: TransactionalRepositories;
    wallet: Wallet;
    tx: WagerTransaction;
    decision: WagerDecision;
    isNew: boolean;
    correlationId: string;
    now: Date;
}): Promise<AppliedWagerResult> {
    const { repos, wallet, tx, decision, isNew, correlationId, now } = params;
    const context = { correlationId, causationId: tx.id };
    const persistTx = (observed: string) =>
        isNew
            ? repos.wagerTransactions.create(tx, observed)
            : repos.wagerTransactions.save(tx, observed);

    if (decision.outcome === "REJECT") {
        tx.reject(decision.failureCode, now);
        await persistTx(wallet.balance.toJSON().amount);
        await repos.outbox.enqueue(
            OutboxMessage.enqueue(WagerTransactionRejected.from({ transaction: tx, context })),
        );
        return {
            transactionId: tx.id,
            status: tx.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
            failureCode: tx.failureCode,
        };
    }

    if (decision.outcome === "PENDING_REFERENCE") {
        if (isNew) {
            tx.markPendingReference();
            await persistTx(wallet.balance.toJSON().amount);
            await repos.outbox.enqueue(
                OutboxMessage.enqueue(
                    WagerTransactionPendingReference.from({ transaction: tx, context }),
                ),
            );
        }
        return {
            transactionId: tx.id,
            status: tx.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
        };
    }

    if (decision.outcome === "PROCESS_NO_BALANCE") {
        tx.markProcessed(decision.referenceTransactionId, now);
        await persistTx(wallet.balance.toJSON().amount);
        await repos.outbox.enqueue(
            OutboxMessage.enqueue(WagerTransactionProcessed.from({ transaction: tx, context })),
        );
        return {
            transactionId: tx.id,
            status: tx.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: false,
        };
    }

    const ledgerEntryId = crypto.randomUUID();
    const entry =
        decision.direction === LedgerDirection.Debit
            ? wallet.debit({ ledgerEntryId, transactionId: tx.id, money: tx.money, at: now })
            : wallet.credit({ ledgerEntryId, transactionId: tx.id, money: tx.money, at: now });

    tx.markProcessed(decision.referenceTransactionId, now);
    await repos.wallets.save(wallet);
    await repos.wallets.appendLedgerEntry(entry);
    await persistTx(wallet.balance.toJSON().amount);
    await repos.outbox.enqueue(
        OutboxMessage.enqueue(WagerTransactionProcessed.from({ transaction: tx, context })),
    );
    await repos.outbox.enqueue(
        OutboxMessage.enqueue(WalletBalanceChanged.from({ wallet, entry, context })),
    );

    return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
    };
}