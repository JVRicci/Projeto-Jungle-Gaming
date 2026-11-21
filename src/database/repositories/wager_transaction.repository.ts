import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
    WagerTransactionStatus,
    type WagerTransaction,
    WagerTransactionKind,
} from "../../domain/wager/wager_transaction";
import type {
    StoredWagerTransaction,
    WagerTransactionRepository,
} from "../../ports/wager_transaction.repository.port";
import { WagerTransactionOrmEntity } from "../entities";
import { WagerTransactionMapper } from "../mappers";
import { type PendingReferenceItem } from "../../ports/wager_transaction.repository.port";

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
    constructor(private readonly em: EntityManager) {}

    async findById(id: string): Promise<StoredWagerTransaction | null> {
        const record = await this.em.findOne(WagerTransactionOrmEntity, { id });
        return record ? WagerTransactionMapper.toDomain(record) : null;
    }

    async findByIdempotencyKey(idempotencyKey: string): Promise<StoredWagerTransaction | null> {
        const record = await this.em.findOne(WagerTransactionOrmEntity, { idempotencyKey });
        return record ? WagerTransactionMapper.toDomain(record) : null;
    }

    async findByProviderExternalId(
        providerId: string,
        externalTransactionId: string,
    ): Promise<StoredWagerTransaction | null> {
        const record = await this.em.findOne(WagerTransactionOrmEntity, {
            providerId,
            externalTransactionId,
        });
        return record ? WagerTransactionMapper.toDomain(record) : null;
    }

    async hasProcessedReversal(
        referenceTransactionId: string,
    ): Promise<boolean> {
        const count = await this.em.count(WagerTransactionOrmEntity, {
            referenceTransactionId,
            kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
            status: WagerTransactionStatus.Processed,
        });
        return count > 0;
    }

    async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceItem[]> {
        const rows = await this.em.find(
            WagerTransactionOrmEntity,
            {
                status: WagerTransactionStatus.PendingReference,
                $or: [{ referenceNextAttemptAt: null }, { referenceNextAttemptAt: { $lte: now } }],
            },
            { orderBy: { createdAt: "ASC" }, limit },
        );
        return rows.map((row) => ({
            transaction: WagerTransactionMapper.toDomain(row).transaction,
            referenceAttempts: row.referenceAttempts,
        }));
    }

    async findPendingReferenceById(id: string): Promise<PendingReferenceItem | null> {
        const row = await this.em.findOne(WagerTransactionOrmEntity, {
            id,
            status: WagerTransactionStatus.PendingReference,
        });
        return row
            ? {
                  transaction: WagerTransactionMapper.toDomain(row).transaction,
                  referenceAttempts: row.referenceAttempts,
              }
            : null;
    }

    async scheduleReferenceRetry(id: string, attempts: number, nextAttemptAt: Date): Promise<void> {
        await this.em.nativeUpdate(
            WagerTransactionOrmEntity,
            { id },
            { referenceAttempts: attempts, referenceNextAttemptAt: nextAttemptAt },
        );
    }

    async create(tx: WagerTransaction, observedBalance?: string): Promise<void> {
        this.em.create(
            WagerTransactionOrmEntity,
            WagerTransactionMapper.toPersistence(tx, observedBalance),
        );
        await this.em.flush();
    }

    async save(tx: WagerTransaction, observedBalance?: string): Promise<void> {
        const ref = this.em.getReference(WagerTransactionOrmEntity, tx.id);
        ref.status = tx.status;
        ref.referenceTransactionId = tx.referenceTransactionId ?? null;
        ref.failureCode = tx.failureCode ?? null;
        ref.processedAt = tx.processedAt ?? null;
        if (observedBalance !== undefined) {
            ref.observedBalance = observedBalance;
        }
        await this.em.flush();
    }
}