## 1. Objetivo

A API tem como objetivo receber operações de apostas e atualizar carteiras sem duplicar movimentações. 
O banco é a principal fonte de acertividade para decisões da aplicação, considerando saldo, transações e lançamentos.
Mesmo com mensagens repetidas, atrasadas ou processadas ao mesmo tempo, a API e seus dados devem continuar funcionando integralmente.

## 2. Desenho geral:
- No projeto foi utilizada arquitetura em camadas, seprando o código com portas e adaptadors.
    
    -src/domain: comporta todos os dominios e seus testes, sendo o núcleo da aplicação. Nele encontramos dominios para Wallet, WalletLedgerEntry, WagerTransaction, InboxMessage, OutboxMessage além da classe responsável pelo tratamento dos erros de dominio

    -src/ports: possui os contratos de persistência e transação, sendo eles: UnitOfWork, WalletRepository, WagerTransactionRepository, InboxRepository, OutboxRepository. Esses contratos fazem referência as entidades do banco de dados da aplicação

    - src/database: armazena as entidades do banco e da ORM (MikroORM), além da migration responsável por gerar a estrutura do banco.

## 3. Modelo de Domínio e Persistência

- Estrutura do banco e por que MikroORM?

    - Devido a vaga ser focada em MikroORM, optei por ela ao invés de TypeORM. Além disso, foi uma escolha benéfica porque com ela há uma melhor oportunidade de implementar Mappers, o pattrern Unit of Work e também os Identities Maps de forma explicita. Junto a isso é possível executar transações de forma isolada devido ao EntityManager. Mas para mim uma das maiores vantagens é o suporte nativo ao pessimistic lock, o qual foi minha escolha para implementação de controle de concorrência.

    - No PostgreSQL, é composto em colunas NUMERIC(20, 2) (amount, balance, balance_before, balance_after, observed_balance) + currency VARCHAR(3).

    - Nas ORM entities, p.decimal('string') garante que valores monetários trafeguem sempre como string, nunca number/float.

- Papel dos mappers:

    - Os Mappers atuam como adaptadores entre o modelo relacional (*Record) e o domínio, chamando toJSON() na gravação e rehydrate() na leitura (sem revalidar regras de transição). Basicamente eles traduzem os dados vindos do banco dentro dos dominios

    - Eu criei tabelas inteiramente baseadas nos dominios da aplicação, entretanto eu tomei algumas liberdades. 

    - No domínio, Money é um Value Object imutável baseado em Decimal (com escala fixa de 2 casas) composto por { amount, currency }.

    - wallets: UNIQUE (player_id, currency) impede carteiras duplicadas por moeda. CHECK (balance >= 0) bloqueia saldo negativo na camada do banco.

    - wallet_ledger_entries: UNIQUE (wallet_id, transaction_id) garante que haverá no máximo 1 lançamento por transação/carteira. Enquanto CHECK (amount > 0) e trigger BEFORE UPDATE OR DELETE (trg_ledger_immutable) adciona imutabilidade (append-only).

    - wager_transactions: UNIQUE (provider_id, external_transaction_id) e UNIQUE (idempotency_key) + payload_hash garantem idempotência persistente e detecção de conflito; observed_balance preserva o saldo no instante do processamento ou  da rejeição. O índice único uq_wager_single_reversal (WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')) impede reversão duplicada sem bloquear o registro de tentativas REJECTED. Sobre inclusão de idempotencia nessa tabela e não em uma dedicada, no tópico 6 explico melhor essa decisão

    - inbox_messages / outbox_messages: Primary key composta (consumer_name, message_id) para eliminar duplicatas de consumo SQS e índice de pendentes para publicação assíncrona.

- Detalhes na modelagem dos repositórios:

    - WalletRepository agrupa tanto Wallet quanto WalletLedgerEntry


## 4. Garantias Distribuídas

## 5. Contratos, Erros e Segurança

- Não incluí contratos nos domínios, pois contratos normalmente têm o objetivo de abstrair implementações e inverter dependências. Incluir isso adicionaria complexidade e polimorfismo sem necessidade para esses casos.

- Centralizei os erros de dominio em DomainError. O motivo disso foi evitar a criação de inumeras classes de tratamento de erro e permitir maior facildade de identificar erros pelas camadas externas, como a API e os Workers.

## 6. Decisões Arquiteturais (ADRs), Trade-offs e Limitações

- Em relação a idepotencia relacionada a tabela wager_transactions, optei por implementar a idepotency_key (usando constraint UNIQUE) e payload_hash. na própria tabela e não criar uma tabela dedicada. Inicialmente pensei em uma tabela dedicada por conta de reutilização para possíveis funcionalidades, mas devido ao escopo do projeto atual, centralizei nessa tabela. Além disso, agindo dessa forma, riscos de dessincronização são evitados, gera menos complexidade na tabela (pois teria um JOIN para SELECT e mais um INSERT)

- O motivo de eu utilizar porta especifica do PostgreSQL foi devido a uma limitação da minha maquina, por isso ela está com a porta 5433.

- Sobre centralizar erros de dominio em classe especifica, existe um trade-off: Como code hoje é string, o TypeScript não impede erro de digitação nem obriga o mapeamento HTTP a cobrir todos os códigos. É possivel evoluir no futuro com enum por exemplo