import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

export const OutboxMessageOrmEntity = defineEntity({
    name: 'OutboxMessageOrmEntity',
    tableName: 'outbox_messages',
    properties: {
        id: p.string().primary().length(36),
        aggregateId: p.string().length(36),
        eventType: p.string().length(100),
        payload: p.json<Record<string, unknown>>().columnType('jsonb'),
        occurredAt: p.datetime().columnType('timestamptz'),
        attempts: p.integer().default(0),
        nextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
        publishedAt: p.datetime().columnType('timestamptz').nullable(),
    },
});

export type OutboxMessageRecord = InferEntity<typeof OutboxMessageOrmEntity>;