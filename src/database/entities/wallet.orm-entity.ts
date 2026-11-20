import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

export const WalletOrmEntity = defineEntity({
    name: 'WalletOrmEntity',
    tableName: 'wallets',
    properties: {
        id: p.string().primary().length(36),
        playerId: p.string().length(36),
        currency: p.string().length(3),
        balance: p.decimal('string').precision(20).scale(2),
        version: p.integer().default(1),
        createdAt: p.datetime().columnType('timestamptz'),
        updatedAt: p.datetime().columnType('timestamptz'),
  },
})

export type WalletRecord = InferEntity<typeof WalletOrmEntity>