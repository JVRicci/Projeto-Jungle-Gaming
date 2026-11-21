import { InboxMessageOrmEntity } from "./inbox_message.orm-entity";
import { OutboxMessageOrmEntity } from "./outbox_message.orm-entity";
import { WagerTransactionOrmEntity } from "./wager_transaction.orm-entity";
import { WalletOrmEntity } from "./wallet.orm-entity";
import { WalletLedgerEntries } from "./wallet_ledger_entry.orm-entity";

export * from "./wallet.orm-entity";
export * from "./wallet_ledger_entry.orm-entity";
export * from "./wager_transaction.orm-entity";
export * from "./inbox_message.orm-entity";
export * from "./outbox_message.orm-entity";

export const ORM_ENTITIES = [
    WalletOrmEntity,
    WalletLedgerEntries,
    WagerTransactionOrmEntity,
    InboxMessageOrmEntity,
    OutboxMessageOrmEntity,
];