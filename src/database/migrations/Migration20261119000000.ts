import { Migration } from '@mikro-orm/migrations'

export class Migration20261119000000 extends Migration {
    override async up(): Promise<void> {
        this.addSql(`
            -- 1. Tabela wallets
            CREATE TABLE wallets (
                id VARCHAR(36) PRIMARY KEY,
                player_id VARCHAR(36) NOT NULL,
                currency VARCHAR(3) NOT NULL,
                balance NUMERIC(20, 2) NOT NULL,
                version INT NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL,
                CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
                CONSTRAINT chk_wallets_balance_positive CHECK (balance >= 0)
            );

            -- 2. Tabela wallet_ledger_entries
            CREATE TABLE wallet_ledger_entries (
                id VARCHAR(36) PRIMARY KEY,
                wallet_id VARCHAR(36) NOT NULL REFERENCES wallets(id),
                transaction_id VARCHAR(36) NOT NULL,
                direction VARCHAR(10) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
                amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
                currency VARCHAR(3) NOT NULL,
                balance_before NUMERIC(20, 2) NOT NULL,
                balance_after NUMERIC(20, 2) NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id)
            );

            CREATE INDEX idx_ledger_wallet_created ON wallet_ledger_entries (wallet_id, created_at DESC);
            -- Trigger de Imutabilidade (Append-Only) para o Ledger
            CREATE OR REPLACE FUNCTION prevent_ledger_modification()

            RETURNS TRIGGER AS $$
            BEGIN
                RAISE EXCEPTION 'Lançamentos do ledger são imutáveis e não podem ser atualizados ou removidos';
            END;
            $$ LANGUAGE plpgsql;

            CREATE TRIGGER trg_ledger_immutable
            BEFORE UPDATE OR DELETE ON wallet_ledger_entries
            FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();

            -- 3. Tabela wager_transactions
            CREATE TABLE wager_transactions (
                id VARCHAR(36) PRIMARY KEY,
                provider_id VARCHAR(100) NOT NULL,
                external_transaction_id VARCHAR(100) NOT NULL,
                idempotency_key VARCHAR(255) NOT NULL,
                payload_hash VARCHAR(64) NOT NULL,
                wallet_id VARCHAR(36) NOT NULL REFERENCES wallets(id),
                player_id VARCHAR(36) NOT NULL,
                round_id VARCHAR(100) NOT NULL,
                game_id VARCHAR(100) NOT NULL,
                kind VARCHAR(20) NOT NULL,
                amount NUMERIC(20, 2) NOT NULL,
                observed_balance NUMERIC(20, 2),
                currency VARCHAR(3) NOT NULL,
                status VARCHAR(30) NOT NULL,
                reference_external_transaction_id VARCHAR(100),
                reference_transaction_id VARCHAR(36),
                failure_code VARCHAR(50),
                created_at TIMESTAMPTZ NOT NULL,
                processed_at TIMESTAMPTZ,
                CONSTRAINT uq_wager_provider_external_tx UNIQUE (provider_id, external_transaction_id),
                CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key)
            );

            CREATE INDEX idx_wager_ref ON wager_transactions (provider_id, reference_external_transaction_id);

            CREATE INDEX idx_wager_pending_ref ON wager_transactions (status, created_at) WHERE status = 'PENDING_REFERENCE';

            CREATE UNIQUE INDEX uq_wager_single_reversal ON wager_transactions (reference_transaction_id, kind)
            WHERE status = 'PROCESSED'
            AND kind IN ('REFUND', 'ROLLBACK')
            AND reference_transaction_id IS NOT NULL;

            -- 4. Tabela inbox_messages
            CREATE TABLE inbox_messages (
                message_id VARCHAR(255) NOT NULL,
                consumer_name VARCHAR(100) NOT NULL,
                payload_hash VARCHAR(64) NOT NULL,
                received_at TIMESTAMPTZ NOT NULL,
                processed_at TIMESTAMPTZ,
                PRIMARY KEY (consumer_name, message_id)
            );

            -- 5. Tabela outbox_messages
            CREATE TABLE outbox_messages (
                id VARCHAR(36) PRIMARY KEY,
                aggregate_id VARCHAR(36) NOT NULL,
                event_type VARCHAR(100) NOT NULL,
                payload JSONB NOT NULL,
                occurred_at TIMESTAMPTZ NOT NULL,
                attempts INT NOT NULL DEFAULT 0,
                next_attempt_at TIMESTAMPTZ,
                published_at TIMESTAMPTZ
            );

            CREATE INDEX idx_outbox_pending ON outbox_messages (published_at, next_attempt_at, occurred_at);
        `);
    }

    override async down(): Promise<void> {
        this.addSql(`
            DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;
            DROP FUNCTION IF EXISTS prevent_ledger_modification();
            DROP TABLE IF EXISTS outbox_messages;
            DROP TABLE IF EXISTS inbox_messages;
            DROP TABLE IF EXISTS wager_transactions;
            DROP TABLE IF EXISTS wallet_ledger_entries;
            DROP TABLE IF EXISTS wallets;
        `);
    }
}