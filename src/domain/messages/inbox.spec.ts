import { describe, expect, it } from "bun:test";
import { InboxMessage } from "./inbox";

describe("InboxMessage", () => {
  it("registra o recebimento de uma mensagem em estado não processado", () => {
    const msg = InboxMessage.receive({
      messageId: "msg-123",
      consumerName: "wager-consumer",
      payloadHash: "hash-xyz",
    });

    expect(msg.messageId).toBe("msg-123");
    expect(msg.consumerName).toBe("wager-consumer");
    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();
  });

  it("marca a mensagem como processada", () => {
    const msg = InboxMessage.receive({
      messageId: "msg-123",
      consumerName: "wager-consumer",
      payloadHash: "hash-xyz",
    });

    const now = new Date();
    msg.markProcessed(now);

    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(now);
  });

  it("reidrata uma mensagem a partir do banco de dados", () => {
    const receivedAt = new Date("2026-01-01T10:00:00Z");
    const processedAt = new Date("2026-01-01T10:00:05Z");

    const msg = InboxMessage.rehydrate({
      messageId: "msg-123",
      consumerName: "wager-consumer",
      payloadHash: "hash-xyz",
      receivedAt,
      processedAt,
    });

    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(processedAt);
  });
});