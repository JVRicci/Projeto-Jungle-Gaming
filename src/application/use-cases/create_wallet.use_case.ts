import { Inject, Injectable } from "@nestjs/common";
import { WagerTransactionProcessed } from "../../domain/events/wager_transaction_processed";
import { WalletBalanceChanged } from "../../domain/events/wallet_balance_changed";
import { OutboxMessage } from "../../domain/messages/outbox";
import { Money, type MoneyProps } from "../../domain/money/money";
import { DomainError } from "../../domain/shared/domain-error";
import { WagerTransaction, WagerTransactionKind } from "../../domain/wager/wager_transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet/wallet_ledger_entry";
import { UNIT_OF_WORK, type UnitOfWork } from "../../ports/unit_of_work.port";
import { canonicalPayloadHash } from "../canonical_payload_hash";
import { isUniqueConstraintError } from "../pg_errors";

export interface CreateWalletInput {
    playerId: string;
    initialBalance: MoneyProps;
    correlationId?: string;
}

export interface CreateWalletOutput {
    id: string;
    playerId: string;
    balance: MoneyProps;
    version: number;
}

@Injectable()
export class CreateWalletUseCase {
    constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

    async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
        const initialBalance = Money.from(input.initialBalance);
        const walletId = crypto.randomUUID();
        const correlationId = input.correlationId ?? crypto.randomUUID();

        const wallet = Wallet.open({
            id: walletId,
            playerId: input.playerId,
            initialBalance,
        });

        try {
            await this.uow.run(async ({ wallets, wagerTransactions, outbox }) => {
                const existing = await wallets.findByPlayerAndCurrency(
                    wallet.playerId,
                    wallet.currency,
                );
                if (existing) {
                    throw new DomainError(
                        "WALLET_ALREADY_EXISTS",
                        `Já existe uma carteira para o jogador ${wallet.playerId} na moeda ${wallet.currency}`,
                    );
                }

                await wallets.create(wallet);

                if (initialBalance.isPositive()) {
                    const openingTxId = crypto.randomUUID();
                    const openingTx = WagerTransaction.create({
                        id: openingTxId,
                        providerId: "internal",
                        externalTransactionId: openingTxId,
                        idempotencyKey: `internal:opening:${wallet.id}`,
                        payloadHash: canonicalPayloadHash({
                            walletId: wallet.id,
                            playerId: wallet.playerId,
                            initialBalance: initialBalance.toJSON(),
                        }),
                        walletId: wallet.id,
                        playerId: wallet.playerId,
                        roundId: "opening",
                        gameId: "opening",
                        kind: WagerTransactionKind.Opening,
                        money: initialBalance,
                        createdAt: wallet.createdAt,
                    });
                    openingTx.markProcessed(undefined, wallet.createdAt);

                    const entry = WalletLedgerEntry.create({
                        id: crypto.randomUUID(),
                        walletId: wallet.id,
                        transactionId: openingTx.id,
                        direction: LedgerDirection.Credit,
                        money: initialBalance,
                        balanceBefore: Money.zero(wallet.currency),
                        balanceAfter: initialBalance,
                        createdAt: wallet.createdAt,
                    });

                    await wagerTransactions.create(openingTx, initialBalance.toJSON().amount);
                    await wallets.appendLedgerEntry(entry);

                    const context = { correlationId, causationId: openingTx.id };
                    await outbox.enqueue(
                        OutboxMessage.enqueue(
                            WagerTransactionProcessed.from({ transaction: openingTx, context }),
                        ),
                    );
                    await outbox.enqueue(
                        OutboxMessage.enqueue(
                            WalletBalanceChanged.from({ wallet, entry, context }),
                        ),
                    );
                }
            });
        } catch (err) {
            if (isUniqueConstraintError(err)) {
                throw new DomainError(
                    "WALLET_ALREADY_EXISTS",
                    `Já existe uma carteira para o jogador ${wallet.playerId} na moeda ${wallet.currency}`,
                );
            }
            throw err;
        }

        return {
            id: wallet.id,
            playerId: wallet.playerId,
            balance: wallet.balance.toJSON(),
            version: wallet.version,
        };
    }
}