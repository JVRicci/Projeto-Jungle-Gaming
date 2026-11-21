import { Inject, Injectable } from "@nestjs/common";
import { InboxMessage } from "../../domain/messages/inbox";
import { Money, type MoneyProps } from "../../domain/money/money";
import { DomainError } from "../../domain/shared/domain-error";
import { WagerTransaction, WagerTransactionKind } from "../../domain/wager/wager_transaction";
import {
    UNIT_OF_WORK,
    type TransactionalRepositories,
    type UnitOfWork,
} from "../../ports/unit_of_work.port";
import { hashWagerPayload } from "../canonical_payload_hash";
import { isUniqueConstraintError } from "../pg_errors";
import { validateAgainstWallet } from "../wager_rules";
import {
    WAGER_STRATEGIES,
    applyWagerDecision,
    type AppliedWagerResult,
    type WagerDecision,
} from "../wager_strategies";

export interface ProcessWagerTransactionInput {
    idempotencyKey: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
    correlationId?: string;
    inbox?: { consumerName: string; messageId: string };
}

export type ProcessWagerTransactionOutput = AppliedWagerResult;

@Injectable()
export class ProcessWagerTransactionUseCase {
    constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

    async execute(input: ProcessWagerTransactionInput): Promise<ProcessWagerTransactionOutput> {
        if (!input.idempotencyKey?.trim()) {
            throw new DomainError("MISSING_IDEMPOTENCY_KEY", "Idempotency-Key é obrigatória");
        }
        if (input.kind === WagerTransactionKind.Opening) {
            throw new DomainError(
                "INTERNAL_KIND_NOT_ALLOWED",
                "Operações OPENING são internas e não podem ser submetidas externamente",
            );
        }

        const kind = input.kind;
        const money = Money.from(input.money);
        const payloadHash = hashWagerPayload({ ...input, kind, money: money.toJSON() });
        const correlationId = input.correlationId ?? crypto.randomUUID();
        const now = new Date();

        try {
            return await this.uow.run(async (repos) => {
                const wallet = await repos.wallets.findByIdForUpdate(input.walletId);

                const existing = await this.findExisting(repos, input);
                if (existing) {
                    if (!existing.transaction.matchesPayload(payloadHash)) {
                        throw new DomainError(
                            "IDEMPOTENCY_CONFLICT",
                            "Idempotency-Key já utilizada com payload diferente",
                        );
                    }
                    if (input.inbox) {
                        await this.markInboxProcessed(repos, input.inbox, payloadHash, now);
                    }
                    return this.replayOf(
                        existing.transaction,
                        existing.observedBalance ?? wallet?.balance.toJSON().amount,
                    );
                }

                if (!wallet) {
                    throw new DomainError(
                        "WALLET_NOT_FOUND",
                        `Carteira não encontrada: ${input.walletId}`,
                    );
                }

                const tx = WagerTransaction.create({
                    id: crypto.randomUUID(),
                    providerId: input.providerId,
                    externalTransactionId: input.externalTransactionId,
                    idempotencyKey: input.idempotencyKey,
                    payloadHash,
                    walletId: input.walletId,
                    playerId: input.playerId,
                    roundId: input.roundId,
                    gameId: input.gameId,
                    kind,
                    money,
                    referenceExternalTransactionId: input.referenceExternalTransactionId,
                    createdAt: now,
                });

                const walletError = validateAgainstWallet(wallet, tx);
                const decision: WagerDecision = walletError
                    ? { outcome: "REJECT", failureCode: walletError }
                    : await WAGER_STRATEGIES[kind].evaluate({ repos, wallet, tx });

                const result = await applyWagerDecision({
                    repos,
                    wallet,
                    tx,
                    decision,
                    isNew: true,
                    correlationId,
                    now,
                });

                if (input.inbox) {
                    await this.markInboxProcessed(repos, input.inbox, payloadHash, now);
                }

                return result;
            });
        } catch (err) {
            if (isUniqueConstraintError(err)) {
                return this.handleRaceReplay(input, payloadHash);
            }
            throw err;
        }
    }

    private findExisting(repos: TransactionalRepositories, input: ProcessWagerTransactionInput) {
        return repos.wagerTransactions
            .findByIdempotencyKey(input.idempotencyKey)
            .then(
                (found) =>
                    found ??
                    repos.wagerTransactions.findByProviderExternalId(
                        input.providerId,
                        input.externalTransactionId,
                    ),
            );
    }

    private async markInboxProcessed(
        repos: TransactionalRepositories,
        inboxInfo: { consumerName: string; messageId: string },
        payloadHash: string,
        now: Date,
    ): Promise<void> {
        const existing = await repos.inbox.findByKey(inboxInfo.consumerName, inboxInfo.messageId);
        if (!existing) {
            const msg = InboxMessage.receive({ ...inboxInfo, payloadHash, receivedAt: now });
            msg.markProcessed(now);
            await repos.inbox.create(msg);
        } else if (!existing.isProcessed()) {
            existing.markProcessed(now);
            await repos.inbox.save(existing);
        }
    }

    private async handleRaceReplay(
        input: ProcessWagerTransactionInput,
        payloadHash: string,
    ): Promise<ProcessWagerTransactionOutput> {
        return this.uow.run(async (repos) => {
            const existing = await this.findExisting(repos, input);
            if (!existing) {
                throw new DomainError("INTERNAL_ERROR", "Conflito inesperado ao processar transação");
            }
            if (!existing.transaction.matchesPayload(payloadHash)) {
                throw new DomainError(
                    "IDEMPOTENCY_CONFLICT",
                    "Idempotency-Key já utilizada com payload diferente",
                );
            }
            return this.replayOf(existing.transaction, existing.observedBalance);
        });
    }

    private replayOf(tx: WagerTransaction, observedBalance?: string): ProcessWagerTransactionOutput {
        return {
            transactionId: tx.id,
            status: tx.status,
            balance: { amount: observedBalance ?? "0.00", currency: tx.money.currency },
            idempotentReplay: true,
            failureCode: tx.failureCode,
        };
    }
}