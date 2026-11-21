import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { CreateWalletUseCase } from "../application/use-cases/create_wallet.use_case";
import { ProcessWagerTransactionUseCase } from "../application/use-cases/process_wager_transaction.use_case";
import { ReconcileWalletUseCase } from "../application/use-cases/reconcile_wallet.use_case";
import { DatabaseModule } from "../database/database.module";
import { DomainExceptionFilter } from "./domain_exception.filter";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

@Module({
    imports: [DatabaseModule],
    controllers: [WalletsController, WageringController],
    providers: [
        CreateWalletUseCase,
        ProcessWagerTransactionUseCase,
        ReconcileWalletUseCase,
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
    ],
    exports: [ProcessWagerTransactionUseCase],
})
export class HttpModule {}