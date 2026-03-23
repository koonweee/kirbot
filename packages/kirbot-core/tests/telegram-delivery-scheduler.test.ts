import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TELEGRAM_DELIVERY_POLICY,
  TelegramDeliveryScheduler,
  type TelegramDeliverySupersededResult
} from "../src/telegram-delivery-scheduler";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function rateLimitError(retryAfterSeconds: number): Error & {
  error_code: number;
  parameters: { retry_after: number };
} {
  const error = new Error("Too Many Requests") as Error & {
    error_code: number;
    parameters: { retry_after: number };
  };

  error.error_code = 429;
  error.parameters = { retry_after: retryAfterSeconds };
  return error;
}

function zeroPolicy() {
  return {
    callbackAnswerSpacingMs: 0,
    visibleSendSpacingMs: 0,
    topicCreateSpacingMs: 0,
    visibleEditSpacingMs: 0,
    chatActionSpacingMs: 0,
    deleteSpacingMs: 0
  };
}

describe("TelegramDeliveryScheduler", () => {
  it("exposes conservative visible edit spacing and per-class 429 backoff defaults", () => {
    expect(DEFAULT_TELEGRAM_DELIVERY_POLICY).toMatchObject({
      callbackAnswerBackoffAfter429Ms: expect.any(Number),
      visibleSendBackoffAfter429Ms: expect.any(Number),
      topicCreateBackoffAfter429Ms: expect.any(Number),
      visibleEditBackoffAfter429Ms: expect.any(Number),
      deleteBackoffAfter429Ms: expect.any(Number),
      chatActionBackoffAfter429Ms: expect.any(Number)
    });
    expect(DEFAULT_TELEGRAM_DELIVERY_POLICY.visibleEditSpacingMs).toBeGreaterThan(500);
  });

  it("dispatches callback answers ahead of queued visible edits", async () => {
    const scheduler = new TelegramDeliveryScheduler(zeroPolicy());
    const events: string[] = [];

    const visibleEdit = scheduler.enqueue({
      deliveryClass: "visible_edit",
      execute: async () => {
        events.push("visible_edit");
        return "edited";
      }
    });

    const callbackAnswer = scheduler.enqueue({
      deliveryClass: "callback_answer",
      execute: async () => {
        events.push("callback_answer");
        return "answered";
      }
    });

    await expect(callbackAnswer).resolves.toBe("answered");
    await expect(visibleEdit).resolves.toBe("edited");
    expect(events).toEqual(["callback_answer", "visible_edit"]);
  });

  it("prioritizes visible work ahead of deletes and chat actions after callback answers", async () => {
    const scheduler = new TelegramDeliveryScheduler(zeroPolicy());
    const blocker = createDeferred<string>();
    const events: string[] = [];

    scheduler.enqueue({
      deliveryClass: "callback_answer",
      execute: async () => blocker.promise
    });

    const deleteOperation = scheduler.enqueue({
      deliveryClass: "delete",
      execute: async () => {
        events.push("delete");
        return "deleted";
      }
    });

    const chatAction = scheduler.enqueue({
      deliveryClass: "chat_action",
      execute: async () => {
        events.push("chat_action");
        return "typing";
      }
    });

    const visibleSend = scheduler.enqueue({
      deliveryClass: "visible_send",
      execute: async () => {
        events.push("visible_send");
        return "sent";
      }
    });

    const topicCreate = scheduler.enqueue({
      deliveryClass: "topic_create",
      execute: async () => {
        events.push("topic_create");
        return "created";
      }
    });

    blocker.resolve("done");

    await expect(visibleSend).resolves.toBe("sent");
    await expect(topicCreate).resolves.toBe("created");
    await expect(deleteOperation).resolves.toBe("deleted");
    await expect(chatAction).resolves.toBe("typing");
    expect(events).toEqual(["visible_send", "topic_create", "delete", "chat_action"]);
  });

  it("pauses only the class that hits retry_after 429", async () => {
    vi.useFakeTimers();

    try {
      const scheduler = new TelegramDeliveryScheduler({
        ...zeroPolicy(),
        visibleEditBackoffAfter429Ms: 0
      });
      const events: string[] = [];
      let attempts = 0;

      const visibleEdit = scheduler.enqueue({
        deliveryClass: "visible_edit",
        execute: async () => {
          attempts += 1;
          events.push(`visible_edit:${attempts}`);

          if (attempts === 1) {
            throw rateLimitError(2);
          }

          return "edited";
        }
      });

      await Promise.resolve();
      expect(attempts).toBe(1);
      expect(events).toEqual(["visible_edit:1"]);

      const callbackAnswer = scheduler.enqueue({
        deliveryClass: "callback_answer",
        execute: async () => {
          events.push("callback_answer");
          return "answered";
        }
      });

      await expect(callbackAnswer).resolves.toBe("answered");
      expect(events).toEqual(["visible_edit:1", "callback_answer"]);

      await vi.advanceTimersByTimeAsync(2000);
      await expect(visibleEdit).resolves.toBe("edited");
      expect(attempts).toBe(2);
      expect(events).toEqual(["visible_edit:1", "callback_answer", "visible_edit:2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the configured 429 backoff floor for the affected class", async () => {
    vi.useFakeTimers();

    try {
      const pausedEvents: Array<{
        deliveryClass: string;
        retryAfterMs: number;
        effectivePauseMs: number;
        pauseUntil: number;
      }> = [];
      const scheduler = new TelegramDeliveryScheduler(
        {
          visibleEditSpacingMs: 0,
          visibleEditBackoffAfter429Ms: 3000
        },
        {
          onClassPaused: event => {
            pausedEvents.push(event);
          }
        }
      );
      let attempts = 0;

      const visibleEdit = scheduler.enqueue({
        deliveryClass: "visible_edit",
        execute: async () => {
          attempts += 1;

          if (attempts === 1) {
            throw rateLimitError(1);
          }

          return "edited";
        }
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(attempts).toBe(1);
      expect(pausedEvents).toHaveLength(1);
      expect(pausedEvents[0]).toMatchObject({
        deliveryClass: "visible_edit",
        retryAfterMs: 1000,
        effectivePauseMs: 3000
      });
      expect(pausedEvents[0].pauseUntil).toEqual(expect.any(Number));

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(2000);
      await expect(visibleEdit).resolves.toBe("edited");
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a newer replaceable job ahead when an older in-flight same-key job retries after 429", async () => {
    vi.useFakeTimers();

    try {
      const pausedEvents: Array<{
        deliveryClass: string;
        retryAfterMs: number;
        effectivePauseMs: number;
      }> = [];
      const scheduler = new TelegramDeliveryScheduler({
        ...zeroPolicy(),
        visibleEditBackoffAfter429Ms: 0
      }, {
        onClassPaused: event => {
          pausedEvents.push({
            deliveryClass: event.deliveryClass,
            retryAfterMs: event.retryAfterMs,
            effectivePauseMs: event.effectivePauseMs
          });
        }
      });
      const gate = createDeferred<void>();
      const events: string[] = [];
      let oldAttempts = 0;

      const old = scheduler.enqueue({
        deliveryClass: "visible_edit",
        replaceable: true,
        coalescingKey: "edit:race",
        execute: async () => {
          oldAttempts += 1;
          events.push(`old:${oldAttempts}`);
          await gate.promise;

          if (oldAttempts === 1) {
            throw rateLimitError(1);
          }

          return "old";
        }
      });

      await Promise.resolve();
      expect(oldAttempts).toBe(1);

      const newer = scheduler.enqueue({
        deliveryClass: "visible_edit",
        replaceable: true,
        coalescingKey: "edit:race",
        execute: async () => {
          events.push("new");
          return "new";
        }
      });

      gate.resolve();
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }

      expect(pausedEvents).toEqual([
        {
          deliveryClass: "visible_edit",
          retryAfterMs: 1000,
          effectivePauseMs: 1000
        }
      ]);
      expect(events).toEqual(["old:1"]);

      let newerResolved = false;
      newer.then(() => {
        newerResolved = true;
      });

      await vi.advanceTimersByTimeAsync(999);
      await Promise.resolve();
      expect(newerResolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(newer).resolves.toBe("new");
      await expect(old).resolves.toEqual({
        kind: "telegram_delivery_superseded",
        deliveryClass: "visible_edit",
        coalescingKey: "edit:race"
      });
      expect(events).toEqual(["old:1", "new"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send superseded in-flight replaceable jobs to onFailure after later non-429 errors", async () => {
    const onFailureCalls: Array<{ deliveryClass: string; error: unknown }> = [];
    const scheduler = new TelegramDeliveryScheduler(
      {
        visibleEditSpacingMs: 0,
        visibleEditBackoffAfter429Ms: 0
      },
      {
        onFailure: event => {
          onFailureCalls.push(event);
        }
      }
    );
    const gate = createDeferred<void>();
    const old = scheduler.enqueue({
      deliveryClass: "visible_edit",
      replaceable: true,
      coalescingKey: "edit:failure",
      execute: async () => {
        await gate.promise;
        throw new Error("stale boom");
      }
    });

    await Promise.resolve();

    const newer = scheduler.enqueue({
      deliveryClass: "visible_edit",
      replaceable: true,
      coalescingKey: "edit:failure",
      execute: async () => "new"
    });

    gate.resolve();

    await expect(old).resolves.toEqual({
      kind: "telegram_delivery_superseded",
      deliveryClass: "visible_edit",
      coalescingKey: "edit:failure"
    });
    await expect(newer).resolves.toBe("new");
    expect(onFailureCalls).toEqual([]);
  });

  it("isolates throwing hooks from scheduler state and errors", async () => {
    vi.useFakeTimers();

    try {
      const scheduler = new TelegramDeliveryScheduler(
        {
          visibleEditSpacingMs: 0,
          visibleEditBackoffAfter429Ms: 0
        },
        {
          onQueued() {
            throw new Error("queued hook failed");
          },
          onClassPaused() {
            throw new Error("pause hook failed");
          },
          onFailure() {
            throw new Error("failure hook failed");
          }
        }
      );

      let editAttempts = 0;
      const retriedEdit = scheduler.enqueue({
        deliveryClass: "visible_edit",
        execute: async () => {
          editAttempts += 1;
          if (editAttempts === 1) {
            throw rateLimitError(1);
          }
          return "edited";
        }
      });

      await Promise.resolve();
      expect(editAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(retriedEdit).resolves.toBe("edited");
      expect(editAttempts).toBe(2);

      const failingSend = scheduler.enqueue({
        deliveryClass: "visible_send",
        execute: async () => {
          throw new Error("boom");
        }
      });

      await expect(failingSend).rejects.toThrow("boom");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves superseded replaceable operations instead of hanging", async () => {
    const scheduler = new TelegramDeliveryScheduler(zeroPolicy());
    const blocker = createDeferred<string>();
    const started: string[] = [];

    const blockerOperation = scheduler.enqueue({
      deliveryClass: "callback_answer",
      execute: async () => blocker.promise
    });

    const first = scheduler.enqueue({
      deliveryClass: "visible_edit",
      replaceable: true,
      coalescingKey: "edit:1",
      execute: async () => {
        started.push("first");
        return "first";
      }
    });

    const second = scheduler.enqueue({
      deliveryClass: "visible_edit",
      replaceable: true,
      coalescingKey: "edit:1",
      execute: async () => {
        started.push("second");
        return "second";
      }
    });

    await expect(first).resolves.toEqual({
      kind: "telegram_delivery_superseded",
      deliveryClass: "visible_edit",
      coalescingKey: "edit:1"
    } satisfies TelegramDeliverySupersededResult);
    expect(started).toEqual([]);

    blocker.resolve("done");
    await expect(blockerOperation).resolves.toBe("done");
    await expect(second).resolves.toBe("second");
    expect(started).toEqual(["second"]);
  });

  it("deduplicates chat actions by chat id, topic id, and action", async () => {
    const scheduler = new TelegramDeliveryScheduler(zeroPolicy());
    const blocker = createDeferred<string>();
    const started: string[] = [];

    scheduler.enqueue({
      deliveryClass: "callback_answer",
      execute: async () => blocker.promise
    });

    const first = scheduler.enqueue({
      deliveryClass: "chat_action",
      replaceable: true,
      coalescingKey: "chat_action:-1001:77:typing",
      execute: async () => {
        started.push("first");
        return "first";
      }
    });

    const second = scheduler.enqueue({
      deliveryClass: "chat_action",
      replaceable: true,
      coalescingKey: "chat_action:-1001:77:typing",
      execute: async () => {
        started.push("second");
        return "second";
      }
    });

    await expect(first).resolves.toEqual({
      kind: "telegram_delivery_superseded",
      deliveryClass: "chat_action",
      coalescingKey: "chat_action:-1001:77:typing"
    } satisfies TelegramDeliverySupersededResult);
    expect(started).toEqual([]);

    blocker.resolve("done");
    await expect(second).resolves.toBe("second");
    expect(started).toEqual(["second"]);
  });

  it("preserves FIFO ordering for non-coalescible visible sends and topic creates", async () => {
    const scheduler = new TelegramDeliveryScheduler(zeroPolicy());
    const events: string[] = [];

    const visibleSend = scheduler.enqueue({
      deliveryClass: "visible_send",
      execute: async () => {
        events.push("visible_send");
        return "sent";
      }
    });

    const topicCreate = scheduler.enqueue({
      deliveryClass: "topic_create",
      execute: async () => {
        events.push("topic_create");
        return "created";
      }
    });

    await expect(visibleSend).resolves.toBe("sent");
    await expect(topicCreate).resolves.toBe("created");
    expect(events).toEqual(["visible_send", "topic_create"]);
  });
});
