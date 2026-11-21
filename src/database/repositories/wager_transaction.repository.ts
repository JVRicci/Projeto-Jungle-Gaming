import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import {
    WagerTransactionStatus,
    type WagerTransaction,
    type WagerTransactionKind,
} from "../../domain/wager/wager_transaction";
import type {
    StoredWagerTransaction,
    WagerTransactionRepository,
} from "../../ports/wager_transaction.repository.port";
import { WagerTransactionOrmEntity } from "../entities";
import { WagerTransactionMapper } from "../mappers";

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
        kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
    ): Promise<boolean> {
        const count = await this.em.count(WagerTransactionOrmEntity, {
            referenceTransactionId,
            kind,
            status: WagerTransactionStatus.Processed,
        });
        return count > 0;
    }

    async findPendingReferences(limit: number): Promise<WagerTransaction[]> {
        const rows = await this.em.find(
            WagerTransactionOrmEntity,
            { status: WagerTransactionStatus.PendingReference },
            {
                orderBy: { createdAt: "ASC" },
                limit,
                lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
            },
        );
        return rows.map((row) => WagerTransactionMapper.toDomain(row).transaction);
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