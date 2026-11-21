## 1. Objetivo

A API tem como objetivo receber operações de apostas e atualizar carteiras sem duplicar movimentações, perder eventos confirmados ou permitir saldo negativo. O banco de dados é a fonte da verdade para decisões da aplicação — considerando saldo, transações e lançamentos no ledger. Mesmo com mensagens repetidas, atrasadas, fora de ordem ou processadas simultaneamente por múltiplas instâncias, a aplicação e seus dados permanecem íntegros.

---

## 2. Desenho Geral

Foi adotada uma arquitetura em camadas inspirada em **Portas e Adaptadores (Hexagonal simplificada)**, mantendo o domínio puro e isolado de frameworks:

- `src/domain/`: núcleo puro da aplicação (sem decorators de NestJS ou MikroORM). Contém `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, `InboxMessage`, `OutboxMessage`, eventos de integração tipados (`IntegrationEvent`) e `DomainError`.
- `src/ports/`: contratos (interfaces) de persistência e transação (`UnitOfWork`, `WalletRepository`, `WagerTransactionRepository`, `InboxRepository`, `OutboxRepository`) + tokens `Symbol` para injeção de dependência no NestJS.
- `src/application/`: orquestração de casos de uso (`CreateWalletUseCase`, `ProcessWagerTransactionUseCase`, `ReconcileWalletUseCase`), hash canônico (`canonicalPayloadHash`), helpers de erro PostgreSQL (`pg_errors.ts`), regras puras (`wager_rules.ts`) e Strategy por tipo de operação (`wager_strategies.ts`).
- `src/database/`: adaptador de persistência com MikroORM 7 (`migrations/`, `entities/`, `mappers.ts`, `repositories/`, `database.module.ts`).
- `src/http/`: camada HTTP NestJS (`WalletsController`, `WageringController`, `DomainExceptionFilter`, `ProviderAuthGuard`).
- `src/messaging/`: integração SQS FIFO e workers (`SqsWagerConsumer`, `OutboxPublisherWorker`, `PendingReferenceWorker`).
- `src/observability/` e `src/health/`: `StructuredLogger`, `MetricsService`, `GET /metrics`, `GET /health/live` e `GET /health/ready`.

```text
[HTTP Controller] ──┐
                    ├──▶ [ProcessWagerTransactionUseCase] ──▶ [UnitOfWork (1 TX SQL)]
[SQS Consumer] ─────┘         │ (Strategy por kind)                 │
                              ▼                                     ├── wallets (FOR UPDATE)
                     [Domain Entities + Money]                      ├── wallet_ledger_entries (append-only)
                                                                    ├── wager_transactions (idempotency + observed_balance)
                                                                    ├── inbox_messages (SQS dedup)
                                                                    └── outbox_messages ──▶ [OutboxPublisherWorker] ──▶ SQS Events
```

---

## 3. Modelo de Domínio e Persistência

### 3.1 Escolha do MikroORM 7 e Mapeamento do `Money`

- Além do alinhamento com a stack do desafio, o **MikroORM 7** foi escolhido por oferecer *Data Mapper*, *Unit of Work* e *Identity Map* explícitos, transações isoladas via `em.transactional()` e suporte nativo a `LockMode.PESSIMISTIC_WRITE` (`FOR UPDATE`) e `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`).
- As ORM entities utilizam `defineEntity` (API nativa do MikroORM 7) em vez de decorators `@Entity()`, mantendo `src/domain/` 100% desacoplado do ORM.
- No domínio, `Money` é um Value Object imutável baseado em `Decimal` (precisão 40, escala fixa de 2 casas decimais), composto por `{ amount, currency }`.
- No PostgreSQL, `Money` é decomposto em colunas `NUMERIC(20, 2)` (`amount`, `balance`, `balance_before`, `balance_after`, `observed_balance`) + `currency VARCHAR(3)`. Nas ORM entities, `p.decimal('string')` garante que valores monetários trafeguem **sempre como `string`**, nunca `number`/`float`.

### 3.2 Papel dos Mappers (`src/database/mappers.ts`)

- Os Mappers atuam como adaptadores bidirecionais entre o modelo relacional (`*Record`) e o domínio: decompõem `Money` via `toJSON()` na gravação e reconstroem entidades via `rehydrate()` na leitura (sem revalidar regras de transição).

### 3.3 Invariantes garantidas no schema do PostgreSQL

- **`wallets`:** `UNIQUE (player_id, currency)` impede carteiras duplicadas por moeda; `CHECK (balance >= 0)` impede saldo negativo na camada do banco.
- **`wallet_ledger_entries`:** `UNIQUE (wallet_id, transaction_id)` garante no máximo 1 lançamento por transação/carteira; `CHECK (amount > 0)` e trigger `BEFORE UPDATE OR DELETE` (`trg_ledger_immutable`) garantem imutabilidade (*append-only*).
- **`wager_transactions`:** `UNIQUE (provider_id, external_transaction_id)` e `UNIQUE (idempotency_key)` + `payload_hash` garantem idempotência persistente e detecção de conflito; `observed_balance` preserva o saldo observado no instante da conclusão ou rejeição; o índice único parcial `uq_wager_single_reversal` sobre `(reference_transaction_id)` (`WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL`) impede qualquer dupla reversão (inclusive `REFUND` seguido de `ROLLBACK` na mesma referência) sem bloquear registros auditáveis `REJECTED`. As colunas `reference_attempts` e `reference_next_attempt_at` + índice `idx_wager_pending_ref (reference_next_attempt_at, created_at) WHERE status = 'PENDING_REFERENCE'` sustentam o backoff exponencial de referências pendentes.
- **`inbox_messages` / `outbox_messages`:** PK composta `(consumer_name, message_id)` para deduplicação de consumo SQS e índice `idx_outbox_pending` para publicação assíncrona.

### 3.4 Repositórios e Transições de Estado da `WagerTransaction`

- `WalletRepository` agrupa o Aggregate Root `Wallet` e seu `WalletLedgerEntry` (expondo apenas `appendLedgerEntry`, reforçando *append-only* no contrato).
- A paginação do ledger (`listLedgerEntries`) usa cursor opaco em Base64URL contendo `(createdAt, id)` ordenados `DESC`, garantindo estabilidade mesmo com múltiplos registros no mesmo milissegundo. Cursores malformados lançam `DomainError("INVALID_CURSOR")` (HTTP 400).
- **Transições válidas da `WagerTransaction`:**
  - `PENDING` → `PROCESSED` | `REJECTED` | `PENDING_REFERENCE` | `FAILED`
  - `PENDING_REFERENCE` → `PROCESSED` | `REJECTED` | `FAILED`
  - `PROCESSED`, `REJECTED` e `FAILED` são **estados terminais** (tentar transicioná-los lança `DomainError("INVALID_TRANSACTION_STATE")`).

---

## 4. Garantias Distribuídas

### 4.1 Estratégia Transacional (`UnitOfWork`)

- `MikroOrmUnitOfWork.run(work)` encapsula `em.transactional(async (txEm) => ...)`, criando um `EntityManager` isolado para a transação SQL e entregando os repositórios (`wallets`, `wagerTransactions`, `inbox`, `outbox`) ligados ao **mesmo `txEm`**.
- Garante atomicidade real: alteração de saldo, lançamento no ledger, gravação da transação, registro de inbox (quando SQS) e enfileiramento na outbox confirmam ou sofrem rollback juntos.

### 4.2 Controle de Concorrência (`walletId`)

- **Unidade de concorrência:** `walletId` (sem lock global — carteiras distintas executam em paralelo).
- **Estratégia:** **Pessimistic Locking** por linha da carteira via `findByIdForUpdate(walletId)` (`LockMode.PESSIMISTIC_WRITE` + `refresh: true` → `SELECT ... FOR UPDATE`).
- O lock é adquirido antes da checagem de inbox e idempotência para serializar tanto disputas de saldo quanto rajadas duplicadas na mesma *hot wallet* entre 3+ instâncias, evitando tempestades de retries. Um `catch` para violação de `UNIQUE` (`23505`) cobre ainda corridas raras entre wallets diferentes com mesma `idempotency_key`.
- A coluna `version` inicia em `1` na abertura da carteira (inclusive quando `initialBalance > 0` com transação interna `OPENING`) e é incrementada exclusivamente pelo domínio em `debit()`/`credit()`.

### 4.3 Processamento Assíncrono, Outbox e Referências Fora de Ordem

- **SQS Consumer (`SqsWagerConsumer`):** reutiliza o mesmo `ProcessWagerTransactionUseCase` da API HTTP, consulta e grava `inbox_messages` na mesma transação SQL (1ª linha de defesa por `(consumerName, messageId)`, antes da `idempotency_key`) e executa `DeleteMessage` (**ack**) **somente após o commit** no PostgreSQL.
  - Erros de negócio → persistidos como `REJECTED` + ack.
  - Erros permanentes de contrato/JSON ou `IDEMPOTENCY_CONFLICT` → encaminhados para `wager-transactions-dlq.fifo` + ack.
  - Erros transitórios de infra → sem ack, com backoff exponencial via `ChangeMessageVisibility` protegido por `try/catch` (`min(2^receiveCount, SQS_MAX_BACKOFF_SECONDS)`) até o limite de 5 tentativas configurado na `RedrivePolicy` da fila.
  - Em `SIGTERM`, encerra o loop, conclui a mensagem em andamento ou devolve visibilidade (`VisibilityTimeout: 0`).
- **Transactional Outbox (`OutboxPublisherWorker`):** múltiplas instâncias consomem lotes com `LockMode.PESSIMISTIC_PARTIAL_WRITE` (`SELECT ... FOR UPDATE SKIP LOCKED`), publicam em `wager-events.fifo` com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`, e aplicam backoff exponencial (`scheduleRetry`) em falhas de publicação.
- **Referências fora de ordem (`PendingReferenceWorker`):** executa em **2 fases** para eliminar risco de deadlock — lê candidatas vencidas (`reference_next_attempt_at <= now`) sem lock e processa **1 transação SQL por item**, travando a `wallet` primeiro (mesma ordem de lock do caminho HTTP/SQS) e relendo o estado após o lock. Enquanto a referência não chega, aplica backoff exponencial persistido (`1s → 2s → 4s → 8s → 15s` via `reference_attempts` e `reference_next_attempt_at`); esgotado o TTL configurável (`PENDING_REF_TTL_MS`, padrão `30000ms` — cobre atrasos normais de provedores sem manter transações em limbo), finaliza como `REJECTED` com `REFERENCE_TTL_EXPIRED` e publica `WagerTransactionRejected`.

---

## 5. Contratos, Erros, Observabilidade e Segurança

### 5.1 Contratos, `payloadHash` e Erros

- Não foram criados contratos/interfaces desnecessários dentro de `src/domain/`; as portas vivem em `src/ports/` para inverter dependências na camada de aplicação.
- Os erros de domínio são centralizados em `DomainError(code, message)`, simplificando o mapeamento nas bordas (API HTTP e Workers).
- **Algoritmo de `payloadHash` (`src/application/canonical_payload_hash.ts`):** seleciona exclusivamente os campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money: { amount, currency }` e `referenceExternalTransactionId`), remove chaves `undefined`, ordena recursivamente todas as chaves do JSON e gera SHA-256 em hexadecimal (64 chars). Headers e metadados de transporte nunca entram no hash.
- **Mapeamento consistente de status HTTP (`DomainExceptionFilter` + Controllers):**
  - `200 OK` / `201 Created` — operação processada (`PROCESSED`, replay idempotente, consultas, criação de wallet)
  - `202 Accepted` — aceita aguardando referência (`PENDING_REFERENCE`)
  - `400 Bad Request` — payload, header `Idempotency-Key`, cursor ou valor monetário inválido
  - `404 Not Found` — wallet ou transação inexistente
  - `409 Conflict` — wallet duplicada ou `IDEMPOTENCY_CONFLICT` (mesma key ou `messageId` com payload diferente)
  - `422 Unprocessable Entity` — rejeição por regra de negócio (`status: "REJECTED"` + `failureCode`)
  - `503 Service Unavailable` — falha transitória de banco/infraestrutura (incluindo códigos de lock/serialização PostgreSQL `40001`, `40P01`, `55P03`)
- **Taxonomia de `FailureCode`:** separa erros de saldo (`INSUFFICIENT_FUNDS` para apostas vs `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` para reversões), referência (`REFERENCE_NOT_FOUND`, `REFERENCE_TTL_EXPIRED`, `REFERENCE_ALREADY_SETTLED`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`), dados (`CURRENCY_MISMATCH`, `INVALID_AMOUNT`, `WALLET_NOT_FOUND`) e infra (`INTERNAL_ERROR`).

### 5.2 Observabilidade

- **Logs estruturados (12-Factor App):** `StructuredLogger` centraliza todos os logs da aplicação emitindo JSON no `stdout`/`stderr` com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, sem registrar valores monetários, payloads financeiros ou mensagens cruas de banco. A saída via `stdout`/`stderr` permite coleta nativa em containers por agentes como Fluent Bit / Filebeat → Elasticsearch sem depender de arquivos locais efêmeros.
- **Métricas (`GET /metrics`):** expõe transações por status, duplicatas detectadas, retries (SQS/Outbox), mensagens em DLQ, conflitos (`lock` por contenção/código Postgres, `idempotency`, `unique`), divergências de reconciliação, `outboxLag` (contagem e idade da mensagem pendente mais antiga) e latência de processamento (`count`, `avg`, `p50`, `p95`, `p99`).
- **Health checks:** `GET /health/live` (processo vivo) e `GET /health/ready` (conectividade real com PostgreSQL e SQS).

### 5.3 Autenticação (Seção 2 do desafio)

- Conforme permitido na Seção 2, optou-se por **não subir um Identity Provider externo** neste timebox para priorizar correção financeira, concorrência e resiliência distribuída.
- **Ponto de extensão explícito:** `ProviderAuthGuard` (`src/http/provider_auth.guard.ts`) está aplicado via `@UseGuards(ProviderAuthGuard)` nos controllers de negócio (`WalletsController` e `WageringController`), mantendo `/health/live`, `/health/ready` e `/metrics` abertos.
- **Desenho alvo para produção:** integrar um IdP OIDC (como Keycloak ou Zitadel) emitindo tokens JWT via *Client Credentials* para cada provedor; o `ProviderAuthGuard` validaria assinatura JWKS, expiração e claim `provider_id`, garantindo que o provedor autenticado corresponda ao `providerId` do payload.

---

## 6. Decisões Arquiteturais (ADRs), Interpretações e Limitações

### 6.1 Idempotência na tabela `wager_transactions` + `observed_balance`
- **Decisão:** centralizar `idempotency_key` (`UNIQUE`), `payload_hash` e `observed_balance` na própria `wager_transactions`, evitando tabela duplicada, `JOIN` extra e risco de dessincronização quando transações `PENDING_REFERENCE` mudam de status assincronamente.
- **Trade-off / Limitação:** requisições rejeitadas *antes* de existir uma transação persistível (como payload malformado ou `walletId` inexistente por conta da FK) não ficam cacheadas para replay — aceitável pois nunca alteram estado financeiro.

### 6.2 Pessimistic Locking (`FOR UPDATE`) por `walletId`
- **Decisão:** serializar escritas concorrentes por carteira direto no PostgreSQL com `LockMode.PESSIMISTIC_WRITE`.
- **Trade-off:** sob altíssima contenção numa única *hot wallet*, transações mantêm conexões do pool ocupadas enquanto aguardam o lock; para mitigar isso, nenhuma chamada externa (HTTP/SQS) ocorre dentro da `UnitOfWork` (eventos saem de forma assíncrona pela Transactional Outbox).

### 6.3 Reconciliação sem SQL raw (`WalletRepository.calculateBalanceFromLedger`)
- **Decisão:** manter 100% das consultas na API tipada do MikroORM, projetando apenas `direction` e `amount` e recalculando o saldo com `Decimal`.
- **Trade-off / Limitação:** em carteiras com centenas de milhares de lançamentos, carregar linhas em memória consome mais RAM/rede do que um `SUM` no PostgreSQL. Por estar encapsulado atrás da porta `WalletRepository`, migrar para leitura paginada em lotes ou agregação no banco é isolado e transparente para os use cases.

### 6.4 Centralização de erros em `DomainError`
- **Decisão:** evitar proliferação de dezenas de subclasses de erro.
- **Trade-off:** como `code` é `string`, o TypeScript não impede erro de digitação nem obriga exaustividade no mapeamento HTTP; evolução natural futura é tipar `code` com um `enum` ou união literal.

### 6.5 Porta configurável do PostgreSQL (`POSTGRES_PORT`)
- **Decisão:** o `docker-compose.yml` expõe `${POSTGRES_PORT:-5432}:5432`, mantendo `5432` como padrão portável e permitindo sobrescrever (ex.: `5433`) via `.env` local em máquinas que já possuem PostgreSQL nativo rodando na `5432`.

### 6.6 Interpretações adicionais de negócio (Seção 7)
- Uma referência só pode ser revertida **uma única vez, por qualquer tipo** (`REFUND` ou `ROLLBACK`), impedindo crédito duplo em `BET → REFUND → ROLLBACK` apontando para a mesma `BET`. Um `ROLLBACK` apontando para o próprio `REFUND` continua permitido (pois referencia outra transação).
- `WIN` sem `referenceExternalTransactionId` processa normalmente; quando informado e a referência ainda não existe ou está pendente, vai para `PENDING_REFERENCE`; se a referência existir mas não for `BET` `PROCESSED` (ou tiver escopo divergente), é `REJECTED`.
- `LOSS` não altera saldo nem gera lançamento no ledger, mas grava `PROCESSED` com `observed_balance` e publica `WagerTransactionProcessed` (sem `WalletBalanceChanged`).
- Reversão parcial está fora de escopo (o valor deve ser igual ao da referência).

### 6.7 Limitações conhecidas e variáveis de configuração
- **Métricas em memória por instância:** contadores e latências do `MetricsService` são locais por processo (não agregados entre múltiplas instâncias; apenas `outboxLag` é consultado diretamente no PostgreSQL).
- **Outbox dentro da transação do lote:** se a instância cair entre o envio ao SQS e o `COMMIT` de `published_at`, o evento pode ser publicado novamente — comportamento seguro pela deduplicação FIFO (`MessageDeduplicationId = eventId`) e pela idempotência dos consumidores.
- **Autenticação:** `ProviderAuthGuard` no-op, deixando o ponto de extensão pronto para integração OIDC.
- **Segurança de logs:** valores monetários e payloads financeiros não são logados por decisão de segurança.
- **Variáveis de ambiente configuráveis:** `POSTGRES_PORT`, `WORKERS_ENABLED`, `OUTBOX_POLL_MS`, `PENDING_REF_POLL_MS`, `PENDING_REF_TTL_MS`, `SQS_MAX_BACKOFF_SECONDS`, `LOCK_CONTENTION_THRESHOLD_MS`.

================ RESULTADO DO TESTE DE CARGA ================================================

## 7. Teste de Carga (`bun run test:load`)

- **Ambiente:** win32 x64 (12 vCPUs), Bun 1.4.4, PostgreSQL 16 + LocalStack em Docker Compose local.
- **Metodologia:** 20 workers concorrentes por 15.1s contra 10 wallets (40% do tráfego concentrado em 1 *hot wallet* + 60% paralelo), mix de 70% `BET`, 20% `WIN` e 10% replays idempotentes.

| Métrica | Valor |
|---|---|
| Total de requisições | 4645 |
| Throughput | 308.15 req/s |
| Latência média | 64.70 ms |
| Latência p50 / p95 / p99 | 49.36 ms / 127.25 ms / 156.84 ms |
| Taxa de erro (5xx + rede) | 0.00% (0/4645) |
| Distribuição HTTP | {"200":4645} |
| Duplicatas detectadas (replays) | 453 |
| Conflitos de concorrência (lock / unique) | 1486 / 0 |
| Outbox lag ao fim do teste | 14438 pendentes (mais antiga: 55930 ms) |
| Reconciliação pós-carga | 10/10 wallets 100% consistentes |

===========================================================================================