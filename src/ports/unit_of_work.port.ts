import type { InboxRepository } from "./inbox.repository.port";
import type { OutboxRepository } from "./outbox.repository.port";
import type { WagerTransactionRepository } from "./wager_transaction.repository.port";
import type { WalletRepository } from "./wallet.repository.port";

export interface TransactionalRepositories {
    wallets: WalletRepository;
    wagerTransactions: WagerTransactionRepository;
    inbox: InboxRepository;
    outbox: OutboxRepository;
}

export interface UnitOfWork {
    run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const WALLET_REPOSITORY = Symbol("WALLET_REPOSITORY");
export const WAGER_TRANSACTION_REPOSITORY = Symbol("WAGER_TRANSACTION_REPOSITORY");
export const INBOX_REPOSITORY = Symbol("INBOX_REPOSITORY");
export const OUTBOX_REPOSITORY = Symbol("OUTBOX_REPOSITORY");