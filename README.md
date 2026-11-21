# Distributed Wagering Processor

Serviço financeiro distribuído para processamento de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, com garantias de precisão monetária, idempotência persistente, controle de concorrência por carteira, ledger imutável (*append-only*), Inbox/Outbox transacionais e processamento assíncrono via SQS.

## Stack

* **Runtime / Test runner:** Bun 1.x + TypeScript (modo estrito)
* **Framework:** NestJS
* **Banco de dados / ORM:** PostgreSQL 16 + MikroORM 7
* **Mensageria:** AWS SQS FIFO (via LocalStack)
* **Infraestrutura local:** Docker Compose

## Pré-requisitos

* [Bun 1.x](https://bun.sh/)
* Docker e Docker Compose

## Setup local

1. Copie o arquivo de variáveis de ambiente:
   ```bash
   cp .env.example .env
   ```
   *(Se a porta `5432` já estiver ocupada na sua máquina, defina `POSTGRES_PORT=5433` e ajuste a porta em `DATABASE_URL` no `.env`.)*

2. Instale as dependências:
   ```bash
   bun install
   ```

3. Suba PostgreSQL e LocalStack (as filas FIFO `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` são criadas automaticamente na inicialização):
   ```bash
   bun run infra:up
   ```

4. Execute as migrations:
   ```bash
   bun run migration:up
   ```

5. Inicie a aplicação:
   ```bash
   bun run dev
   ```

### Rodando tudo via Docker Compose (incluindo a aplicação)
```bash
docker compose --profile app up --build
```

## Comandos disponíveis

| Comando | Descrição |
|---|---|
| `bun run dev` | Inicia a API + workers em modo watch |
| `bun run start` | Inicia a API + workers |
| `bun run typecheck` | Validação estrita de tipos (`tsc --noEmit`) |
| `bun run infra:up` | Sobe PostgreSQL e LocalStack em background |
| `bun run infra:down` | Derruba os containers |
| `bun run migration:up` | Aplica as migrations pendentes |
| `bun run migration:down` | Reverte a última migration |
| `bun run test:unit` | Executa os testes unitários (`src/`) |
| `bun run test:integration` | Executa as suítes de integração e concorrência (Postgres + LocalStack reais) |
| `bun run test` | Executa toda a suíte (unitários + integração) |
| `bun run test:load` | Executa o teste de carga contra a API rodando (bun run start) |


## Endpoints HTTP

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria carteira (gera `OPENING` + `CREDIT` no ledger quando saldo inicial > 0) |
| `GET` | `/wallets/:walletId` | Consulta saldo e metadados da carteira |
| `GET` | `/wallets/:walletId/ledger?cursor=...&limit=50` | Extrato paginado com cursor estável e opaco |
| `POST` | `/wallets/:walletId/reconciliation` | Reconcilia saldo materializado contra o ledger |
| `POST` | `/wagering/transactions` | Submete transação (header obrigatório: `Idempotency-Key`) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta transação por ID interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta transação por ID do provedor |
| `GET` | `/health/live` | Liveness probe |
| `GET` | `/health/ready` | Readiness probe (PostgreSQL e SQS) |
| `GET` | `/metrics` | Métricas operacionais (status, duplicatas, retries, DLQ, conflitos, outbox lag, latência) |
| `GET` | `/docs` | Documentação interativa Swagger UI (spec em `/docs/openapi.json`) |

## Exemplo rápido (curl)

```bash
# 1. Criar wallet
curl -s -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# 2. Submeter aposta BET (substitua <WALLET_ID>)
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-123" \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<WALLET_ID>","roundId":"round-1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'

# 3. Reconciliar carteira
curl -s -X POST http://localhost:3000/wallets/<WALLET_ID>/reconciliation
```

Consulte [ARCHITECTURE.md](./ARCHITECTURE.md) para detalhes das decisões arquiteturais, controle de concorrência, trade-offs e limitações.