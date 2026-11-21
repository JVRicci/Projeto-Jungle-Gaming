import type { WagerTransaction, WagerTransactionKind } from "../domain/wager/wager_transaction";

export interface StoredWagerTransaction {
    transaction: WagerTransaction;
    observedBalance?: string;
}

export interface WagerTransactionRepository {
    findById(id: string): Promise<StoredWagerTransaction | null>;
    findByIdempotencyKey(idempotencyKey: string): Promise<StoredWagerTransaction | null>;
    findByProviderExternalId(
        providerId: string,
        externalTransactionId: string,
    ): Promise<StoredWagerTransaction | null>;
    hasProcessedReversal(
        referenceTransactionId: string,
        kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
    ): Promise<boolean>;
    findPendingReferences(limit: number): Promise<WagerTransaction[]>;
    create(tx: WagerTransaction, observedBalance?: string): Promise<void>;
    save(tx: WagerTransaction, observedBalance?: string): Promise<void>;
}