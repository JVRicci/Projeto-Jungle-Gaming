export const OPENAPI_SPEC = {
    openapi: "3.0.3",
    info: {
        title: "Distributed Wagering Processor API",
        version: "1.0.0",
        description:
            "Serviço financeiro distribuído para processamento de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) com precisão monetária, idempotência persistente, ledger imutável e Inbox/Outbox transacionais.",
    },
    servers: [{ url: "/" }],
    tags: [
        { name: "Wallets", description: "Gestão de carteiras, ledger e reconciliação" },
        { name: "Wagering", description: "Submissão e consulta de transações de apostas" },
        { name: "Observability", description: "Health checks e métricas operacionais" },
    ],
    components: {
        schemas: {
            Money: {
                type: "object",
                required: ["amount", "currency"],
                properties: {
                    amount: { type: "string", example: "25.00", description: "String decimal com 2 casas" },
                    currency: { type: "string", enum: ["BRL", "USD", "EUR"], example: "BRL" },
                },
            },
            ErrorResponse: {
                type: "object",
                properties: {
                    code: { type: "string", example: "IDEMPOTENCY_CONFLICT" },
                    message: { type: "string", example: "Idempotency-Key já utilizada com payload diferente" },
                },
            },
            CreateWalletRequest: {
                type: "object",
                required: ["playerId", "initialBalance"],
                properties: {
                    playerId: { type: "string", format: "uuid", example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" },
                    initialBalance: { $ref: "#/components/schemas/Money" },
                },
            },
            SubmitWagerRequest: {
                type: "object",
                required: [
                    "providerId",
                    "externalTransactionId",
                    "playerId",
                    "walletId",
                    "roundId",
                    "gameId",
                    "kind",
                    "money",
                ],
                properties: {
                    providerId: { type: "string", example: "provider-a" },
                    externalTransactionId: { type: "string", example: "transaction-123" },
                    playerId: { type: "string", format: "uuid", example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" },
                    walletId: { type: "string", format: "uuid", example: "0192f291-27dd-7d3f-8071-5f8685deef37" },
                    roundId: { type: "string", example: "round-987" },
                    gameId: { type: "string", example: "fortune-chimp" },
                    kind: { type: "string", enum: ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"], example: "BET" },
                    money: { $ref: "#/components/schemas/Money" },
                    referenceExternalTransactionId: {
                        type: "string",
                        nullable: true,
                        description: "Obrigatório para REFUND e ROLLBACK; opcional para WIN",
                    },
                },
            },
            SubmitWagerResponse: {
                type: "object",
                properties: {
                    transactionId: { type: "string", format: "uuid" },
                    status: {
                        type: "string",
                        enum: ["PROCESSED", "PENDING_REFERENCE", "REJECTED", "FAILED"],
                    },
                    balance: { $ref: "#/components/schemas/Money" },
                    idempotentReplay: { type: "boolean" },
                    failureCode: { type: "string", nullable: true },
                },
            },
        },
    },
    paths: {
        "/wallets": {
            post: {
                tags: ["Wallets"],
                summary: "Criar carteira",
                description:
                    "Cria uma carteira para (playerId, currency). Se initialBalance > 0, gera transação interna OPENING e lançamento CREDIT no ledger na mesma transação SQL.",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/CreateWalletRequest" },
                        },
                    },
                },
                responses: {
                    "201": { description: "Carteira criada" },
                    "400": { description: "Payload ou valor monetário inválido" },
                    "409": { description: "Carteira duplicada para (playerId, currency)" },
                },
            },
        },
        "/wallets/{walletId}": {
            get: {
                tags: ["Wallets"],
                summary: "Consultar carteira por ID",
                parameters: [
                    { name: "walletId", in: "path", required: true, schema: { type: "string" } },
                ],
                responses: {
                    "200": { description: "Dados da carteira" },
                    "404": { description: "Carteira não encontrada" },
                },
            },
        },
        "/wallets/{walletId}/ledger": {
            get: {
                tags: ["Wallets"],
                summary: "Listar lançamentos do ledger (paginação por cursor)",
                parameters: [
                    { name: "walletId", in: "path", required: true, schema: { type: "string" } },
                    { name: "cursor", in: "query", required: false, schema: { type: "string" } },
                    {
                        name: "limit",
                        in: "query",
                        required: false,
                        schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
                    },
                ],
                responses: {
                    "200": { description: "Página de lançamentos e nextCursor" },
                    "400": { description: "Cursor ou limit inválido" },
                    "404": { description: "Carteira não encontrada" },
                },
            },
        },
        "/wallets/{walletId}/reconciliation": {
            post: {
                tags: ["Wallets"],
                summary: "Reconciliar saldo materializado contra o ledger",
                parameters: [
                    { name: "walletId", in: "path", required: true, schema: { type: "string" } },
                ],
                responses: {
                    "200": { description: "Relatório de reconciliação (sem correção silenciosa)" },
                    "404": { description: "Carteira não encontrada" },
                },
            },
        },
        "/wagering/transactions": {
            post: {
                tags: ["Wagering"],
                summary: "Submeter transação de aposta",
                parameters: [
                    {
                        name: "Idempotency-Key",
                        in: "header",
                        required: true,
                        schema: { type: "string", example: "provider-a:transaction-123" },
                    },
                    {
                        name: "X-Correlation-Id",
                        in: "header",
                        required: false,
                        schema: { type: "string" },
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/SubmitWagerRequest" },
                        },
                    },
                },
                responses: {
                    "200": {
                        description: "Transação PROCESSED (ou replay idempotente)",
                        content: {
                            "application/json": {
                                schema: { $ref: "#/components/schemas/SubmitWagerResponse" },
                            },
                        },
                    },
                    "202": { description: "Aceita aguardando referência (PENDING_REFERENCE)" },
                    "400": { description: "Payload ou header inválido" },
                    "404": { description: "Carteira não encontrada" },
                    "409": { description: "Conflito de idempotência (payload divergente)" },
                    "422": { description: "Rejeitada por regra de negócio (status: REJECTED)" },
                    "503": { description: "Falha transitória de infraestrutura" },
                },
            },
        },
        "/wagering/transactions/{transactionId}": {
            get: {
                tags: ["Wagering"],
                summary: "Consultar transação por ID interno",
                parameters: [
                    { name: "transactionId", in: "path", required: true, schema: { type: "string" } },
                ],
                responses: {
                    "200": { description: "Transação encontrada" },
                    "404": { description: "Transação não encontrada" },
                },
            },
        },
        "/providers/{providerId}/wagering/transactions/{externalTransactionId}": {
            get: {
                tags: ["Wagering"],
                summary: "Consultar transação por providerId + externalTransactionId",
                parameters: [
                    { name: "providerId", in: "path", required: true, schema: { type: "string" } },
                    { name: "externalTransactionId", in: "path", required: true, schema: { type: "string" } },
                ],
                responses: {
                    "200": { description: "Transação encontrada" },
                    "404": { description: "Transação não encontrada" },
                },
            },
        },
        "/health/live": {
            get: {
                tags: ["Observability"],
                summary: "Liveness probe",
                responses: { "200": { description: "Processo vivo" } },
            },
        },
        "/health/ready": {
            get: {
                tags: ["Observability"],
                summary: "Readiness probe (PostgreSQL e SQS)",
                responses: {
                    "200": { description: "Dependências saudáveis" },
                    "503": { description: "PostgreSQL ou SQS indisponível" },
                },
            },
        },
        "/metrics": {
            get: {
                tags: ["Observability"],
                summary: "Métricas operacionais e outbox lag",
                responses: { "200": { description: "Snapshot de métricas" } },
            },
        },
    },
} as const;