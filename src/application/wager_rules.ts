import {
    FailureCode,
    WagerTransactionKind,
    WagerTransactionStatus,
    type WagerTransaction,
} from "../domain/wager/wager_transaction";
import type { Wallet } from "../domain/wallet/wallet";

const ROLLBACK_ALLOWED_REFS = new Set<WagerTransactionKind>([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
]);

export function isReferenceUnavailable(ref?: WagerTransaction): boolean {
    return (
        !ref ||
        ref.status === WagerTransactionStatus.Pending ||
        ref.status === WagerTransactionStatus.PendingReference
    );
}

export function validateAgainstWallet(wallet: Wallet, tx: WagerTransaction): FailureCode | null {
    if (wallet.playerId !== tx.playerId) return FailureCode.ReferenceMismatch;
    if (wallet.currency !== tx.money.currency) return FailureCode.CurrencyMismatch;
    if (tx.affectsBalance() && !tx.money.isPositive()) return FailureCode.InvalidAmount;
    return null;
}

export function validateReversalReference(
    tx: WagerTransaction,
    ref: WagerTransaction,
    alreadyReversed: boolean,
): FailureCode | null {
    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.InvalidReferenceKind;

    const sameScope =
        ref.providerId === tx.providerId &&
        ref.playerId === tx.playerId &&
        ref.walletId === tx.walletId &&
        ref.roundId === tx.roundId &&
        ref.money.currency === tx.money.currency;
    if (!sameScope) return FailureCode.ReferenceMismatch;

    if (tx.kind === WagerTransactionKind.Refund && ref.kind !== WagerTransactionKind.Bet) {
        return FailureCode.InvalidReferenceKind;
    }
    if (tx.kind === WagerTransactionKind.Rollback && !ROLLBACK_ALLOWED_REFS.has(ref.kind)) {
        return FailureCode.InvalidReferenceKind;
    }
    if (!ref.money.equals(tx.money)) return FailureCode.InvalidAmount;
    if (alreadyReversed) return FailureCode.ReferenceAlreadySettled;

    return null;
}

export function validateWinReference(
    tx: WagerTransaction,
    ref: WagerTransaction,
): FailureCode | null {
    const sameScope =
        ref.playerId === tx.playerId &&
        ref.walletId === tx.walletId &&
        ref.roundId === tx.roundId &&
        ref.money.currency === tx.money.currency;
    return sameScope ? null : FailureCode.ReferenceMismatch;
}