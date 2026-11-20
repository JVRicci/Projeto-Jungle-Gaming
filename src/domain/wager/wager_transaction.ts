import { Money, type MoneyProps } from "../money/money"
import { DomainError } from "../shared/domain-error"
import { LedgerDirection } from "../wallet/wallet_ledger_entry";

enum WagerTransactionKind {
  Opening  = "OPENING",   // interno: crédito de abertura da wallet
  Bet      = "BET",
  Win      = "WIN",
  Loss     = "LOSS",
  Refund   = "REFUND",
  Rollback = "ROLLBACK",
}

enum WagerTransactionStatus {
  Pending          = "PENDING",            // aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE",  // aguardando a transação referenciada
  Processed        = "PROCESSED",          // aplicada (terminal)
  Rejected         = "REJECTED",           // violação de regra de negócio (terminal)
  Failed           = "FAILED",             // erro permanente de infraestrutura (terminal, auditável)
}

export enum FailureCode {
  // 1. Regras de Saldo
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldCauseNegativeBalance = "REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE",

  // 2. Regras de Referência (REFUND / ROLLBACK)
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceTtlExpired = "REFERENCE_TTL_EXPIRED",
  ReferenceAlreadySettled = "REFERENCE_ALREADY_SETTLED", // ex: tentar dar REFUND duas vezes
  ReferenceMismatch = "REFERENCE_MISMATCH",              // player, round ou currency divergentes
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",        // REFUND apontando para algo que não é BET

  // 3. Regras de Dados / Contrato
  CurrencyMismatch = "CURRENCY_MISMATCH",
  InvalidAmount = "INVALID_AMOUNT",
  WalletNotFound = "WALLET_NOT_FOUND",

  // 4. Erros graves de infraestrutura (para status FAILED)
  InternalError = "INTERNAL_ERROR",
}

const validateEnum = <T extends Record<string, string | number>>(  
  enumObject: T,
  value: unknown
): value is T[keyof T] => {
  return Object.values(enumObject).includes(value as T[keyof T]);
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
    private constructor(
      public readonly id: string,
      public readonly providerId: string,
      public readonly externalTransactionId: string,
      public readonly idempotencyKey: string,
      public readonly payloadHash: string,
      public readonly walletId: string,
      public readonly playerId: string,
      public readonly roundId: string,
      public readonly gameId: string,
      public readonly kind: WagerTransactionKind,
      public readonly money: Money,
      /** id no provedor — não o id interno */
      public readonly referenceExternalTransactionId: string | undefined,
      public readonly createdAt: Date,
      private _status: WagerTransactionStatus,
      private _referenceTransactionId?: string,
      private _failureCode?: FailureCode,
      private _processedAt?: Date,
    ) {}

    /** Nasce em PENDING. Valida a exigência de referência por kind. */
    static create(props: CreateWagerTransactionProps): WagerTransaction{
      if((props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) 
        && !props.referenceExternalTransactionId
      ) {
        throw new DomainError("MISSING_REQUIRED_REFERENCE", `Operações do tipo ${props.kind} exigem referenceExternalTransactionId`)
      }
      
      return new WagerTransaction(
        props.id,
        props.providerId,
        props.externalTransactionId,
        props.idempotencyKey,
        props.payloadHash,
        props.walletId,
        props.playerId,
        props.roundId,
        props.gameId,
        props.kind,
        props.money,
        props.referenceExternalTransactionId,
        props.createdAt ?? new Date(),
        WagerTransactionStatus.Pending,
        undefined,
        undefined,
        undefined,
      )
    };

    static rehydrate(state: WagerTransactionState): WagerTransaction {
      return new WagerTransaction(
        state.id,
        state.providerId,
        state.externalTransactionId,
        state.idempotencyKey,
        state.payloadHash,
        state.walletId,
        state.playerId,
        state.roundId,
        state.gameId,
        state.kind,
        state.money instanceof Money ? state.money : Money.from(state.money),
        state.referenceExternalTransactionId,
        new Date(state.createdAt),
        state.status,
        state.referenceTransactionId,
        state.failureCode,
        state.processedAt ? new Date(state.processedAt) : undefined,
      )
    };

    get status(): WagerTransactionStatus { return this._status; }
    get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
    get failureCode(): FailureCode | undefined { return this._failureCode; }
    get processedAt(): Date | undefined { return this._processedAt; }

    // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)
    markProcessed(referenceTransactionId: string | undefined, at: Date): void {
      this.assertNotTerminal();
      this._status = WagerTransactionStatus.Processed;
      this._referenceTransactionId = referenceTransactionId;
      this._processedAt = at
    };

    markPendingReference(): void{
      this.assertNotTerminal();
      this._status = WagerTransactionStatus.PendingReference;
    };

    reject(code: FailureCode, at: Date = new Date()): void{
      this.assertNotTerminal();
      this._status = WagerTransactionStatus.Rejected;
      this._failureCode = code;
      this._processedAt = at
    };
    fail(code: FailureCode, at: Date = new Date()): void{
      this.assertNotTerminal();
      this._status = WagerTransactionStatus.Failed;
      this._failureCode = code;
      this._processedAt = at;
    };

    // ---- consultas de domínio
    isTerminal(): boolean {
      return (
        this._status === WagerTransactionStatus.Processed ||
        this._status === WagerTransactionStatus.Rejected ||
        this._status === WagerTransactionStatus.Failed
      )
    };

    affectsBalance(): boolean{
      return this.kind === WagerTransactionKind.Loss
    };      // false para LOSS

    requiresReference(): boolean{
      return (
        this.kind === WagerTransactionKind.Refund ||
        this.kind === WagerTransactionKind.Rollback
      )
    }; // true para REFUND e ROLLBACK

    matchesPayload(payloadHash: string): boolean{
      return this.payloadHash === payloadHash
    };

    ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection{
      if(this.kind === WagerTransactionKind.Bet)
        return LedgerDirection.Debit;

      if(this.kind in [WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Opening])
        return LedgerDirection.Credit;

      if(this.kind === WagerTransactionKind.Rollback) {
        if(!reference)
          throw new DomainError("MISSING_REFERRENCE", "ROollback exige uma transação de referência para determinar a direção.");

        const refDirection = reference.ledgerDirectionFor();

        return refDirection === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit
      }

      throw new DomainError("NO_LEDGER_FOR_KIND", `Operação do tipo ${this.kind} não gera lançamento no ledger`);
    };

    private assertNotTerminal(): void{
      if(this.isTerminal())
        throw new DomainError(
          "INVALID_TRANSACTION_STATE",
          `Transação ${this.id} já está em estado terminal (${this._status}) e não pode ser alterada`
        );
    }
}