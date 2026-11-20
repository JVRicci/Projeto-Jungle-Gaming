import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

export const InboxMessageOrmEntity = defineEntity({
    name: 'InboxMessageOrmEntity',
    tableName: 'inbox_messages',
    properties: {
        consumerName: p.string().primary().length(100),
        messageId: p.string().primary().length(255),
        payloadHash: p.string().length(64),
        receivedAt: p.datetime().columnType('timestamptz'),
        processedAt: p.datetime().columnType('timestamptz').nullable(),
    },
});

export type InboxMessageRecord = InferEntity<typeof InboxMessageOrmEntity>;