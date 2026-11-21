import type { WagerTransaction } from "../domain/wager/wager_transaction";

export interface StoredWagerTransaction {
    transaction: WagerTransaction;
    observedBalance?: string;
}

export interface PendingReferenceItem {
    transaction: WagerTransaction;
    referenceAttempts: number;
}

export interface WagerTransactionRepository {
    findById(id: string): Promise<StoredWagerTransaction | null>;
    findByIdempotencyKey(idempotencyKey: string): Promise<StoredWagerTransaction | null>;
    findByProviderExternalId(
        providerId: string,
        externalTransactionId: string,
    ): Promise<StoredWagerTransaction | null>;
    hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
    findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceItem[]>;
    findPendingReferenceById(id: string): Promise<PendingReferenceItem | null>;
    scheduleReferenceRetry(id: string, attempts: number, nextAttemptAt: Date): Promise<void>;
    create(tx: WagerTransaction, observedBalance?: string): Promise<void>;
    save(tx: WagerTransaction, observedBalance?: string): Promise<void>;
}