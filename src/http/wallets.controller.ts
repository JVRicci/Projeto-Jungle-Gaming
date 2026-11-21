import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    HttpStatus,
    Inject,
    Param,
    Post,
    Query,
    UseGuards
} from "@nestjs/common";
import { CreateWalletUseCase } from "../application/use-cases/create_wallet.use_case";
import { ReconcileWalletUseCase } from "../application/use-cases/reconcile_wallet.use_case";
import type { MoneyProps } from "../domain/money/money";
import { DomainError } from "../domain/shared/domain-error";
import { WALLET_REPOSITORY } from "../ports/unit_of_work.port";
import type { WalletRepository } from "../ports/wallet.repository.port";
import { ProviderAuthGuard } from "./provider_auth.guard";

interface CreateWalletBody {
    playerId?: string;
    initialBalance?: MoneyProps;
}

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
    constructor(
        private readonly createWallet: CreateWalletUseCase,
        private readonly reconcileWallet: ReconcileWalletUseCase,
        @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    ) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    async create(
        @Body() body: CreateWalletBody,
        @Headers("x-correlation-id") correlationId?: string,
    ) {
        if (!body?.playerId || !body?.initialBalance) {
            throw new DomainError(
                "INVALID_PAYLOAD",
                "Campos obrigatórios: playerId e initialBalance",
            );
        }

        return this.createWallet.execute({
            playerId: body.playerId,
            initialBalance: body.initialBalance,
            correlationId,
        });
    }

    @Get(":walletId")
    async getById(@Param("walletId") walletId: string) {
        const wallet = await this.wallets.findById(walletId);
        if (!wallet) {
            throw new DomainError("WALLET_NOT_FOUND", `Carteira não encontrada: ${walletId}`);
        }

        return {
            id: wallet.id,
            playerId: wallet.playerId,
            balance: wallet.balance.toJSON(),
            version: wallet.version,
            createdAt: wallet.createdAt.toISOString(),
            updatedAt: wallet.updatedAt.toISOString(),
        };
    }

    @Get(":walletId/ledger")
    async listLedger(
        @Param("walletId") walletId: string,
        @Query("cursor") cursor?: string,
        @Query("limit") rawLimit?: string,
    ) {
        const wallet = await this.wallets.findById(walletId);
        if (!wallet) {
            throw new DomainError("WALLET_NOT_FOUND", `Carteira não encontrada: ${walletId}`);
        }

        const parsedLimit = rawLimit === undefined ? 50 : Number(rawLimit);
        if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
            throw new DomainError("INVALID_PAYLOAD", "Parâmetro limit deve ser um inteiro entre 1 e 100");
        }

        const page = await this.wallets.listLedgerEntries({
            walletId,
            cursor,
            limit: parsedLimit,
        });

        return {
            items: page.items.map((entry) => ({
                id: entry.id,
                walletId: entry.walletId,
                transactionId: entry.transactionId,
                direction: entry.direction,
                money: entry.money.toJSON(),
                balanceBefore: entry.balanceBefore.toJSON(),
                balanceAfter: entry.balanceAfter.toJSON(),
                createdAt: entry.createdAt.toISOString(),
            })),
            nextCursor: page.nextCursor,
        };
    }

    @Post(":walletId/reconciliation")
    @HttpCode(HttpStatus.OK)
    async reconcile(@Param("walletId") walletId: string) {
        return this.reconcileWallet.execute(walletId);
    }
}