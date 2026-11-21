import { Inject, Injectable } from "@nestjs/common";
import { Money, type MoneyProps } from "../../domain/money/money";
import { DomainError } from "../../domain/shared/domain-error";
import { UNIT_OF_WORK, type UnitOfWork } from "../../ports/unit_of_work.port";

export interface ReconcileWalletOutput {
    walletId: string;
    storedBalance: MoneyProps;
    calculatedBalance: MoneyProps;
    difference: MoneyProps;
    consistent: boolean;
    checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
    constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

    async execute(walletId: string): Promise<ReconcileWalletOutput> {
        const result = await this.uow.run(async ({ wallets }) => {
            const wallet = await wallets.findById(walletId);
            if (!wallet) {
                throw new DomainError("WALLET_NOT_FOUND", `Carteira não encontrada: ${walletId}`);
            }

            const summary = await wallets.calculateBalanceFromLedger(walletId);
            const calculatedBalance = Money.rehydrate({
                amount: summary.calculatedAmount,
                currency: wallet.currency,
            });
            const difference = wallet.balance.subtract(calculatedBalance);

            return {
                walletId: wallet.id,
                storedBalance: wallet.balance.toJSON(),
                calculatedBalance: calculatedBalance.toJSON(),
                difference: difference.toJSON(),
                consistent: difference.isZero(),
                checkedEntries: summary.checkedEntries,
            };
        });

        if (!result.consistent) {
            console.error(
                JSON.stringify({
                    level: "error",
                    event: "wallet_reconciliation_divergence",
                    walletId: result.walletId,
                    difference: result.difference,
                    checkedEntries: result.checkedEntries,
                }),
            );
        }

        return result;
    }
}