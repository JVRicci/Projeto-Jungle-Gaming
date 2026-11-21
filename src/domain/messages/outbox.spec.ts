import { describe, expect, it } from "bun:test";
import { IntegrationEvent } from "./integration_event";
import { OutboxMessage } from "./outbox";

// Evento fictício para teste
class TestEvent extends IntegrationEvent<{ foo: string }> {
  readonly eventType = "TestEventOccurred";
  readonly version = 1;

  constructor(aggregateId: string) {
    super({
      eventId: "evt-123",
      aggregateId,
      correlationId: "corr-1",
      data: { foo: "bar" },
    });
  }
}

describe("OutboxMessage", () => {
  it("enfileira um evento na outbox em estado pendente", () => {
    const event = new TestEvent("agg-1");
    const outbox = OutboxMessage.enqueue(event);

    expect(outbox.id).toBe("evt-123");
    expect(outbox.aggregateId).toBe("agg-1");
    expect(outbox.eventType).toBe("TestEventOccurred");
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.publishedAt).toBeUndefined();
  });

  it("avalia isDue corretamente conforme o tempo", () => {
    const event = new TestEvent("agg-1");
    const outbox = OutboxMessage.enqueue(event);

    const now = new Date();
    expect(outbox.isDue(now)).toBe(true);

    // Se já foi publicada, não é mais "due"
    outbox.markPublished(now);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(now)).toBe(false);
  });

  it("agenda retry com backoff exponencial incrementando attempts", () => {
    const event = new TestEvent("agg-1");
    const outbox = OutboxMessage.enqueue(event);

    const now = new Date("2026-01-01T12:00:00Z");
    outbox.scheduleRetry(now);

    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBeGreaterThan(now.getTime());

    // Nova tentativa
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(2);
  });
});