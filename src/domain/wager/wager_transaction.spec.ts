import { describe, expect, it } from "bun:test";
import { Money } from "../money/money";
import { LedgerDirection } from "../wallet/wallet_ledger_entry";
import { DomainError } from "../shared/domain-error";
import { 
  WagerTransaction, 
  WagerTransactionKind, 
  WagerTransactionStatus, 
  FailureCode 
} from "./wager_transaction";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

function createValidBet(id = "tx-1") {
  return WagerTransaction.create({
    id,
    providerId: "provider-1",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-1:ext-1",
    payloadHash: "hash-abc",
    walletId: "w-1",
    playerId: "p-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("10.00"),
  });
}

describe("WagerTransaction — Criação", () => {
  it("cria uma aposta (BET) com sucesso nascendo em PENDING", () => {
    const tx = createValidBet();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  it("rejeita criação de REFUND sem referenceExternalTransactionId", () => {
    expect(() => WagerTransaction.create({
      id: "tx-refund",
      providerId: "provider-1",
      externalTransactionId: "ext-refund",
      idempotencyKey: "k-1",
      payloadHash: "hash-1",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Refund,
      money: brl("10.00"),
      // referenceExternalTransactionId omitido
    })).toThrow(DomainError);
  });
});

describe("WagerTransaction — Direção no Ledger e Consultas", () => {
  it("determina a direção correta para BET e WIN", () => {
    const bet = createValidBet();
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(bet.affectsBalance()).toBe(true);

    const win = WagerTransaction.create({
      ...createValidBet(),
      kind: WagerTransactionKind.Win,
    });
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it("inverte a direção no ROLLBACK a partir da referência", () => {
    const bet = createValidBet(); // BET é Debit
    const rollbackOfBet = WagerTransaction.create({
      ...createValidBet("tx-rb"),
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-1",
    });

    // Reverter um débito gera um crédito
    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  it("rejeita gerar ledger para LOSS", () => {
    const loss = WagerTransaction.create({
      ...createValidBet(),
      kind: WagerTransactionKind.Loss,
      money: brl("0.00"),
    });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(DomainError);
  });

  it("rejeita rollback sem transação de referência", () => {
    const rollback = WagerTransaction.create({
      ...createValidBet("tx-rb"),
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-1",
    });
    
    expect(() => rollback.ledgerDirectionFor()).toThrow(DomainError);
  });
});

describe("WagerTransaction — Transições e Estados Terminais", () => {
  it("transiciona para PROCESSED com sucesso", () => {
    const tx = createValidBet();
    const now = new Date();
    tx.markProcessed("ref-internal-1", now);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toEqual(now);
  });

  it("rejeita alteração em transação já terminal", () => {
    const tx = createValidBet();
    tx.reject(FailureCode.InsufficientFunds);

    expect(tx.isTerminal()).toBe(true);
    // Tentar processar transação já rejeitada deve falhar
    expect(() => tx.markProcessed("ref-1", new Date())).toThrow(DomainError);
  });
});