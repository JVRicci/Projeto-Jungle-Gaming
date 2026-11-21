import {
    Body,
    Controller,
    Get,
    Headers,
    HttpStatus,
    Inject,
    Param,
    Post,
    Res,
    UseGuards
} from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../application/use-cases/process_wager_transaction.use_case";
import type { MoneyProps } from "../domain/money/money";
import { DomainError } from "../domain/shared/domain-error";
import {
    WagerTransactionKind,
    WagerTransactionStatus,
    type WagerTransaction,
} from "../domain/wager/wager_transaction";
import { WAGER_TRANSACTION_REPOSITORY } from "../ports/unit_of_work.port";
import type { WagerTransactionRepository } from "../ports/wager_transaction.repository.port";
import { ProviderAuthGuard } from "./provider_auth.guard";

interface SubmitWagerBody {
    providerId?: string;
    externalTransactionId?: string;
    playerId?: string;
    walletId?: string;
    roundId?: string;
    gameId?: string;
    kind?: WagerTransactionKind;
    money?: MoneyProps;
    referenceExternalTransactionId?: string;
}

const VALID_KINDS = new Set<string>(Object.values(WagerTransactionKind));

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
    constructor(
        private readonly processWager: ProcessWagerTransactionUseCase,
        @Inject(WAGER_TRANSACTION_REPOSITORY)
        private readonly wagerTransactions: WagerTransactionRepository,
    ) {}

    @Post("wagering/transactions")
    async submit(
        @Headers("idempotency-key") idempotencyKey: string | undefined,
        @Headers("x-correlation-id") correlationId: string | undefined,
        @Body() body: SubmitWagerBody,
        @Res({ passthrough: true }) res: { status(code: number): unknown },
    ) {
        if (!idempotencyKey?.trim()) {
            throw new DomainError("MISSING_IDEMPOTENCY_KEY", "Header Idempotency-Key é obrigatório");
        }

        if (
            !body?.providerId ||
            !body?.externalTransactionId ||
            !body?.playerId ||
            !body?.walletId ||
            !body?.roundId ||
            !body?.gameId ||
            !body?.kind ||
            !VALID_KINDS.has(body.kind) ||
            !body?.money
        ) {
            throw new DomainError("INVALID_PAYLOAD", "Payload de transação inválido ou incompleto");
        }

        const result = await this.processWager.execute({
            idempotencyKey,
            providerId: body.providerId,
            externalTransactionId: body.externalTransactionId,
            playerId: body.playerId,
            walletId: body.walletId,
            roundId: body.roundId,
            gameId: body.gameId,
            kind: body.kind,
            money: body.money,
            referenceExternalTransactionId: body.referenceExternalTransactionId,
            correlationId,
        });

        if (result.status === WagerTransactionStatus.PendingReference) {
            res.status(HttpStatus.ACCEPTED);
        } else if (result.status === WagerTransactionStatus.Rejected) {
            res.status(HttpStatus.UNPROCESSABLE_ENTITY);
        } else {
            res.status(HttpStatus.OK);
        }

        return result;
    }

    @Get("wagering/transactions/:transactionId")
    async getById(@Param("transactionId") transactionId: string) {
        const stored = await this.wagerTransactions.findById(transactionId);
        if (!stored) {
            throw new DomainError(
                "TRANSACTION_NOT_FOUND",
                `Transação não encontrada: ${transactionId}`,
            );
        }
        return this.serializeTransaction(stored.transaction, stored.observedBalance);
    }

    @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
    async getByProviderExternalId(
        @Param("providerId") providerId: string,
        @Param("externalTransactionId") externalTransactionId: string,
    ) {
        const stored = await this.wagerTransactions.findByProviderExternalId(
            providerId,
            externalTransactionId,
        );
        if (!stored) {
            throw new DomainError(
                "TRANSACTION_NOT_FOUND",
                `Transação não encontrada: ${providerId}/${externalTransactionId}`,
            );
        }
        return this.serializeTransaction(stored.transaction, stored.observedBalance);
    }

    private serializeTransaction(tx: WagerTransaction, observedBalance?: string) {
        return {
            id: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            idempotencyKey: tx.idempotencyKey,
            walletId: tx.walletId,
            playerId: tx.playerId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            kind: tx.kind,
            money: tx.money.toJSON(),
            status: tx.status,
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
            referenceTransactionId: tx.referenceTransactionId,
            failureCode: tx.failureCode,
            observedBalance: observedBalance
                ? { amount: observedBalance, currency: tx.money.currency }
                : undefined,
            createdAt: tx.createdAt.toISOString(),
            processedAt: tx.processedAt?.toISOString(),
        };
    }
}