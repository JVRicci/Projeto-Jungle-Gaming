import os from "node:os";

interface WalletTarget {
    id: string;
    playerId: string;
}

interface ReplaySample {
    wallet: WalletTarget;
    idempotencyKey: string;
    externalTransactionId: string;
    roundId: string;
    kind: "BET" | "WIN";
    amount: string;
}

interface MetricsSnapshot {
    duplicatesDetected: number;
    conflicts: { total: number; lock: number; idempotency: number; unique: number };
    outboxLag: { pendingCount: number; oldestPendingAgeMs: number };
}

const BASE_URL = process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3000";
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const DURATION_SECONDS = Number(process.env.LOAD_DURATION_SECONDS ?? 15);
const WALLET_COUNT = Number(process.env.LOAD_WALLETS ?? 10);

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Number((sorted[idx] ?? 0).toFixed(2));
}

async function ensureReady(): Promise<void> {
    try {
        const res = await fetch(`${BASE_URL}/health/ready`);
        if (res.status === 200) return;
        throw new Error(`Status ${res.status}`);
    } catch {
        console.error(
            `API não está acessível em ${BASE_URL}/health/ready. Suba antes com 'bun run start'.`,
        );
        process.exit(1);
    }
}

async function fetchMetrics(): Promise<MetricsSnapshot> {
    const res = await fetch(`${BASE_URL}/metrics`);
    return (await res.json()) as MetricsSnapshot;
}

async function createWallets(count: number): Promise<WalletTarget[]> {
    const wallets: WalletTarget[] = [];
    for (let i = 0; i < count; i++) {
        const playerId = crypto.randomUUID();
        const res = await fetch(`${BASE_URL}/wallets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                playerId,
                initialBalance: { amount: "100000.00", currency: "BRL" },
            }),
        });
        if (res.status !== 201) {
            throw new Error(`Falha ao criar wallet ${i}: HTTP ${res.status}`);
        }
        const body = (await res.json()) as { id: string };
        wallets.push({ id: body.id, playerId });
    }
    return wallets;
}

async function main(): Promise<void> {
    await ensureReady();

    console.log(
        `Preparando ${WALLET_COUNT} wallets (1 hot wallet = 40% tráfego, ${WALLET_COUNT - 1} paralelas = 60%)...`,
    );
    const wallets = await createWallets(WALLET_COUNT);
    const hotWallet = wallets[0]!;
    const metricsBefore = await fetchMetrics();

    const latencies: number[] = [];
    const statusCounts: Record<string, number> = {};
    const replayPool: ReplaySample[] = [];
    let serverErrors = 0;
    let networkErrors = 0;
    let seq = 0;

    const runId = crypto.randomUUID().slice(0, 8);
    const startedAt = performance.now();
    const endAt = startedAt + DURATION_SECONDS * 1000;

    console.log(
        `Executando teste de carga: ${CONCURRENCY} workers concorrentes por ${DURATION_SECONDS}s contra ${BASE_URL}...`,
    );

    const worker = async () => {
        while (performance.now() < endAt) {
            const roll = Math.random();
            let sample: ReplaySample;

            if (roll < 0.1 && replayPool.length > 0) {
                // 10% replays idempotentes propositais
                const idx = Math.floor(Math.random() * replayPool.length);
                sample = replayPool[idx]!;
            } else {
                // 40% na hot wallet (contenção real de FOR UPDATE), 60% distribuídas
                const target =
                    Math.random() < 0.4 || wallets.length === 1
                        ? hotWallet
                        : wallets[1 + Math.floor(Math.random() * (wallets.length - 1))]!;
                const id = `load-${runId}-${++seq}`;
                const kind: "BET" | "WIN" = roll < 0.8 ? "BET" : "WIN";
                sample = {
                    wallet: target,
                    idempotencyKey: `load-provider:${id}`,
                    externalTransactionId: id,
                    roundId: `round-${id}`,
                    kind,
                    amount: kind === "BET" ? "10.00" : "5.00",
                };
                if (replayPool.length < 200) {
                    replayPool.push(sample);
                }
            }

            const t0 = performance.now();
            try {
                const res = await fetch(`${BASE_URL}/wagering/transactions`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "idempotency-key": sample.idempotencyKey,
                    },
                    body: JSON.stringify({
                        providerId: "load-provider",
                        externalTransactionId: sample.externalTransactionId,
                        playerId: sample.wallet.playerId,
                        walletId: sample.wallet.id,
                        roundId: sample.roundId,
                        gameId: "fortune-chimp",
                        kind: sample.kind,
                        money: { amount: sample.amount, currency: "BRL" },
                    }),
                });
                await res.text();
                const elapsed = performance.now() - t0;
                latencies.push(elapsed);

                const key = String(res.status);
                statusCounts[key] = (statusCounts[key] ?? 0) + 1;
                if (res.status >= 500) serverErrors++;
            } catch {
                latencies.push(performance.now() - t0);
                networkErrors++;
            }
        }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    const totalSeconds = (performance.now() - startedAt) / 1000;

    const metricsAfter = await fetchMetrics();

    // Reconcilia TODAS as wallets após o stress
    let consistentWallets = 0;
    for (const w of wallets) {
        const res = await fetch(`${BASE_URL}/wallets/${w.id}/reconciliation`, { method: "POST" });
        const body = (await res.json()) as { consistent: boolean };
        if (body.consistent) consistentWallets++;
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const totalRequests = latencies.length;
    const rps = totalRequests / totalSeconds;
    const totalErrors = serverErrors + networkErrors;
    const errorRate = totalRequests === 0 ? 0 : (totalErrors / totalRequests) * 100;
    const avgLatency =
        totalRequests === 0 ? 0 : latencies.reduce((acc, v) => acc + v, 0) / totalRequests;

    const lockConflictsDelta = metricsAfter.conflicts.lock - metricsBefore.conflicts.lock;
    const uniqueConflictsDelta = metricsAfter.conflicts.unique - metricsBefore.conflicts.unique;
    const duplicatesDelta = metricsAfter.duplicatesDetected - metricsBefore.duplicatesDetected;

    console.log("\n================ RESULTADO DO TESTE DE CARGA ================================================\n");
    console.log(`## 7. Teste de Carga (\`bun run test:load\`)`);
    console.log("");
    console.log(`- **Ambiente:** ${os.platform()} ${os.arch()} (${os.cpus().length} vCPUs), Bun ${Bun.version}, PostgreSQL 16 + LocalStack em Docker Compose local.`);
    console.log(`- **Metodologia:** ${CONCURRENCY} workers concorrentes por ${totalSeconds.toFixed(1)}s contra ${WALLET_COUNT} wallets (40% do tráfego concentrado em 1 *hot wallet* + 60% paralelo), mix de 70% \`BET\`, 20% \`WIN\` e 10% replays idempotentes.`);
    console.log("");
    console.log("| Métrica | Valor |");
    console.log("|---|---|");
    console.log(`| Total de requisições | ${totalRequests} |`);
    console.log(`| Throughput | ${rps.toFixed(2)} req/s |`);
    console.log(`| Latência média | ${avgLatency.toFixed(2)} ms |`);
    console.log(`| Latência p50 / p95 / p99 | ${percentile(sorted, 50)} ms / ${percentile(sorted, 95)} ms / ${percentile(sorted, 99)} ms |`);
    console.log(`| Taxa de erro (5xx + rede) | ${errorRate.toFixed(2)}% (${totalErrors}/${totalRequests}) |`);
    console.log(`| Distribuição HTTP | ${JSON.stringify(statusCounts)} |`);
    console.log(`| Duplicatas detectadas (replays) | ${duplicatesDelta} |`);
    console.log(`| Conflitos de concorrência (lock / unique) | ${lockConflictsDelta} / ${uniqueConflictsDelta} |`);
    console.log(`| Outbox lag ao fim do teste | ${metricsAfter.outboxLag.pendingCount} pendentes (mais antiga: ${metricsAfter.outboxLag.oldestPendingAgeMs} ms) |`);
    console.log(`| Reconciliação pós-carga | ${consistentWallets}/${wallets.length} wallets 100% consistentes |`);
    console.log("\n===========================================================================================\n");

    if (consistentWallets !== wallets.length) {
        console.error("FALHA CRÍTICA: divergência detectada na reconciliação pós-carga!");
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});