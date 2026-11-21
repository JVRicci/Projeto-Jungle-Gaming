import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import type { TransactionalRepositories, UnitOfWork } from "../../ports/unit_of_work.port";
import { MikroOrmInboxRepository } from "./inbox.repository";
import { MikroOrmOutboxRepository } from "./outbox.repository";
import { MikroOrmWagerTransactionRepository } from "./wager_transaction.repository";
import { MikroOrmWalletRepository } from "./wallet.repository";

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(private readonly em: EntityManager) {}

    async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
        return this.em.transactional(async (txEm) => {
            const repos: TransactionalRepositories = {
                wallets: new MikroOrmWalletRepository(txEm),
                wagerTransactions: new MikroOrmWagerTransactionRepository(txEm),
                inbox: new MikroOrmInboxRepository(txEm),
                outbox: new MikroOrmOutboxRepository(txEm),
            };
            return work(repos);
        });
    }
}