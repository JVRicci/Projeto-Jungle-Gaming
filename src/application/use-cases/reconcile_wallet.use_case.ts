import { Inject, Injectable, Optional} from "@nestjs/common";
import { Money, type MoneyProps } from "../../domain/money/money";
import { DomainError } from "../../domain/shared/domain-error";
import { UNIT_OF_WORK, type UnitOfWork } from "../../ports/unit_of_work.port";
import { MetricsService } from "../../observability/metrics.service";
import { StructuredLogger } from "../../observability/structured_logger";

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
    constructor(
        @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
        @Optional() private readonly metrics?: MetricsService,
        @Optional() private readonly logger?: StructuredLogger,
    ) {}

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
            this.metrics?.recordReconciliationDivergence();
            this.logger?.error("wallet_reconciliation_divergence", {
                walletId: result.walletId,
                checkedEntries: result.checkedEntries,
            });
        }

        return result;
    }
}