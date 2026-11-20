## 1. Objetivo

A API tem como objetivo receber operações de apostas e atualizar carteiras sem duplicar movimentações. 
O banco é a principal fonte de acertividade para decisões da aplicação, considerando saldo, transações e lançamentos.
Mesmo com mensagens repetidas, atrasadas ou processadas ao mesmo tempo, a API e seus dados devem continuar funcionando integralmente.

## 2. Desenho geral:

## 3. Modelo de Domínio e Persistência
- Eu criei tabelas inteiramente baseadas nos dominios da aplicação, entretanto eu tomei algumas liberdades. 

- wallets: UNIQUE (player_id, currency) impede carteiras duplicadas por moeda. CHECK (balance >= 0) bloqueia saldo negativo na camada do banco.

- wallet_ledger_entries: UNIQUE (wallet_id, transaction_id) garante no máximo 1 lançamento por transação/carteira. CHECK (amount > 0) e trigger BEFORE UPDATE OR DELETE (trg_ledger_immutable) adciona imutabilidade (append-only).

- wager_transactions: UNIQUE (provider_id, external_transaction_id) e UNIQUE (idempotency_key) + payload_hash garantem idempotência persistente e detecção de conflito; observed_balance preserva o saldo no instante do processamento ou  da rejeição. O índice único uq_wager_single_reversal (WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')) impede reversão duplicada sem bloquear o registro de tentativas REJECTED. Sobre inclusão de idempotencia nessa tabela e não em uma dedicada, no tópico 6 explico melhor essa decisão

- inbox_messages / outbox_messages: PK composta (consumer_name, message_id) para eliminar duplicatas de consumo SQS e índice de pendentes para publicação assíncrona.

## 4. Garantias Distribuídas

## 5. Contratos, Erros e Segurança

- Não incluí contratos nos domínios, pois contratos normalmente têm o objetivo de abstrair implementações e inverter dependências. Incluir isso adicionaria complexidade e polimorfismo sem necessidade para esses casos.

- Centralizei os erros de dominio em DomainError. O motivo disso foi evitar a criação de inumeras classes de tratamento de erro e permitir maior facildade de identificar erros pelas camadas externas, como a API e os Workers.

## 6. Decisões Arquiteturais (ADRs), Trade-offs e Limitações

- Em relação a idepotencia relacionada a tabela wager_transactions, optei por implementar a idepotency_key (usando constraint UNIQUE) e payload_hash. na própria tabela e não criar uma tabela dedicada. Inicialmente pensei em uma tabela dedicada por conta de reutilização para possíveis funcionalidades, mas devido ao escopo do projeto atual, centralizei nessa tabela. Além disso, agindo dessa forma, riscos de dessincronização são evitados, gera menos complexidade na tabela (pois teria um JOIN para SELECT e mais um INSERT)

- O motivo de eu utilizar porta especifica do PostgreSQL foi devido a uma limitação da minha maquina, por isso ela está com a porta 5433.

- Sobre centralizar erros de dominio em classe especifica, existe um trade-off: Como code hoje é string, o TypeScript não impede erro de digitação nem obriga o mapeamento HTTP a cobrir todos os códigos. É possivel evoluir no futuro com enum por exemplo