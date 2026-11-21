import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import config from "../../mikro-orm.config";
import {
    INBOX_REPOSITORY,
    OUTBOX_REPOSITORY,
    UNIT_OF_WORK,
    WAGER_TRANSACTION_REPOSITORY,
    WALLET_REPOSITORY,
} from "../ports/unit_of_work.port";
import { MikroOrmInboxRepository } from "./repositories/inbox.repository";
import { MikroOrmOutboxRepository } from "./repositories/outbox.repository";
import { MikroOrmUnitOfWork } from "./repositories/unit_of_work";
import { MikroOrmWagerTransactionRepository } from "./repositories/wager_transaction.repository";
import { MikroOrmWalletRepository } from "./repositories/wallet.repository";

@Module({
    imports: [MikroOrmModule.forRoot(config)],
    providers: [
        { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
        { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
        { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
        { provide: INBOX_REPOSITORY, useClass: MikroOrmInboxRepository },
        { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
    ],
    exports: [
        UNIT_OF_WORK,
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        INBOX_REPOSITORY,
        OUTBOX_REPOSITORY,
    ],
})
export class DatabaseModule {}