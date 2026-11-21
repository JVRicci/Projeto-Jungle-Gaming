import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import type { OutboxMessage } from "../../domain/messages/outbox";
import type { OutboxRepository } from "../../ports/outbox.repository.port";
import { OutboxMessageOrmEntity } from "../entities";
import { OutboxMessageMapper } from "../mappers";

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
    constructor(private readonly em: EntityManager) {}

    async enqueue(message: OutboxMessage): Promise<void> {
        this.em.create(OutboxMessageOrmEntity, OutboxMessageMapper.toPersistence(message));
        await this.em.flush();
    }

    async claimPendingBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
        const rows = await this.em.find(
            OutboxMessageOrmEntity,
            {
                publishedAt: null,
                $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
            },
            {
                orderBy: { occurredAt: "ASC" },
                limit,
                lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
            },
        );
        return rows.map(OutboxMessageMapper.toDomain);
    }

    async save(message: OutboxMessage): Promise<void> {
        const ref = this.em.getReference(OutboxMessageOrmEntity, message.id);
        ref.attempts = message.attempts;
        ref.nextAttemptAt = message.nextAttemptAt ?? null;
        ref.publishedAt = message.publishedAt ?? null;
        await this.em.flush();
    }
}