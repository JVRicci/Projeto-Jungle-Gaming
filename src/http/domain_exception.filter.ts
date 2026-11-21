import {
    type ArgumentsHost,
    Catch,
    type ExceptionFilter,
    HttpException,
    HttpStatus,
    Optional
} from "@nestjs/common";
import { DomainError } from "../domain/shared/domain-error";
import type { StructuredLogger } from "../observability/structured_logger";

const DOMAIN_ERROR_STATUS: Record<string, HttpStatus> = {
    WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
    TRANSACTION_NOT_FOUND: HttpStatus.NOT_FOUND,
    WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
    IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
    INVALID_AMOUNT: HttpStatus.BAD_REQUEST,
    INVALID_CURRENCY: HttpStatus.BAD_REQUEST,
    AMOUNT_OUT_OF_RANGE: HttpStatus.BAD_REQUEST,
    INVALID_ID: HttpStatus.BAD_REQUEST,
    INVALID_CURSOR: HttpStatus.BAD_REQUEST,
    INVALID_PAYLOAD: HttpStatus.BAD_REQUEST,
    INITIAL_BALANCE_INVALID: HttpStatus.BAD_REQUEST,
    INITIAL_BALANCE_NEGATIVE: HttpStatus.BAD_REQUEST,
    MISSING_REQUIRED_PLAYER_ID: HttpStatus.BAD_REQUEST,
    MISSING_IDEMPOTENCY_KEY: HttpStatus.BAD_REQUEST,
    MISSING_REQUIRED_REFERENCE: HttpStatus.BAD_REQUEST,
    INTERNAL_KIND_NOT_ALLOWED: HttpStatus.BAD_REQUEST,
};

const TRANSIENT_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "57P01",
    "57P03",
    "08000",
    "08003",
    "08006",
    "53300",
    "40001", 
    "40P01", 
    "55P03"
]);

function isTransientInfraError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: string; cause?: { code?: string } };
    return Boolean(
        (e.code && TRANSIENT_CODES.has(e.code)) ||
            (e.cause?.code && TRANSIENT_CODES.has(e.cause.code)),
    );
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
    constructor(@Optional() private readonly logger?: StructuredLogger) {}

    catch(exception: unknown, host: ArgumentsHost): void {
        const res = host.switchToHttp().getResponse<{
            status(code: number): { json(body: unknown): void };
        }>();

        if (exception instanceof DomainError) {
            const status = DOMAIN_ERROR_STATUS[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
            res.status(status).json({ code: exception.code, message: exception.message });
            return;
        }

        if (exception instanceof HttpException) {
            res.status(exception.getStatus()).json(exception.getResponse());
            return;
        }

        if (isTransientInfraError(exception)) {
            res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
                code: "INFRASTRUCTURE_UNAVAILABLE",
                message: "Dependência temporariamente indisponível; tente novamente",
            });
            return;
        }

        this.logger?.error("unhandled_http_exception", {
            reason: exception instanceof Error ? exception.name : "unknown",
        });

        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
            code: "INTERNAL_ERROR",
            message: "Erro interno inesperado",
        });
    }
}