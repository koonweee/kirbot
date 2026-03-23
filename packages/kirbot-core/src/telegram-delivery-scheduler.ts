export type TelegramDeliveryClass =
  | "callback_answer"
  | "visible_send"
  | "topic_create"
  | "visible_edit"
  | "delete"
  | "chat_action";

export type TelegramDeliverySupersededResult = {
  kind: "telegram_delivery_superseded";
  deliveryClass: TelegramDeliveryClass;
  coalescingKey: string;
};

export interface TelegramDeliveryPolicy {
  callbackAnswerSpacingMs: number;
  callbackAnswerBackoffAfter429Ms: number;
  visibleSendSpacingMs: number;
  visibleSendBackoffAfter429Ms: number;
  topicCreateSpacingMs: number;
  topicCreateBackoffAfter429Ms: number;
  visibleEditSpacingMs: number;
  visibleEditBackoffAfter429Ms: number;
  chatActionSpacingMs: number;
  chatActionBackoffAfter429Ms: number;
  deleteSpacingMs: number;
  deleteBackoffAfter429Ms: number;
}

export const DEFAULT_TELEGRAM_DELIVERY_POLICY: TelegramDeliveryPolicy = {
  callbackAnswerSpacingMs: 0,
  callbackAnswerBackoffAfter429Ms: 1000,
  visibleSendSpacingMs: 250,
  visibleSendBackoffAfter429Ms: 5000,
  topicCreateSpacingMs: 1000,
  topicCreateBackoffAfter429Ms: 10000,
  visibleEditSpacingMs: 1500,
  visibleEditBackoffAfter429Ms: 5000,
  chatActionSpacingMs: 1000,
  chatActionBackoffAfter429Ms: 3000,
  deleteSpacingMs: 100,
  deleteBackoffAfter429Ms: 1000
};

export interface TelegramDeliverySchedulerHooks {
  onQueued?(event: {
    deliveryClass: TelegramDeliveryClass;
    coalescingKey?: string;
    replaceable: boolean;
  }): void;
  onCoalesced?(event: {
    deliveryClass: TelegramDeliveryClass;
    coalescingKey: string;
  }): void;
  onSuperseded?(event: {
    deliveryClass: TelegramDeliveryClass;
    coalescingKey: string;
  }): void;
  onClassPaused?(event: {
    deliveryClass: TelegramDeliveryClass;
    retryAfterMs: number;
    effectivePauseMs: number;
    pauseUntil: number;
  }): void;
  onClassResumed?(event: { deliveryClass: TelegramDeliveryClass }): void;
  onFailure?(event: {
    deliveryClass: TelegramDeliveryClass;
    error: unknown;
  }): void;
}

export type TelegramDeliveryOperation<T> = {
  deliveryClass: TelegramDeliveryClass;
  execute: () => Promise<T>;
  replaceable?: boolean;
  coalescingKey?: string;
};

type PendingTelegramDeliveryOperation<T> = {
  id: number;
  order: number;
  operation: TelegramDeliveryOperation<T>;
  resolve: (value: T | TelegramDeliverySupersededResult) => void;
  reject: (reason: unknown) => void;
};

const NON_CALLBACK_CLASSES: TelegramDeliveryClass[] = [
  "visible_send",
  "topic_create",
  "visible_edit",
  "delete",
  "chat_action"
];

export class TelegramDeliveryScheduler {
  private readonly policy: TelegramDeliveryPolicy;
  private readonly hooks: TelegramDeliverySchedulerHooks;
  private readonly queues = new Map<TelegramDeliveryClass, Array<PendingTelegramDeliveryOperation<unknown>>>();
  private readonly replaceablePending = new Map<string, PendingTelegramDeliveryOperation<unknown>>();
  private readonly pauseUntil = new Map<TelegramDeliveryClass, number>();
  private readonly lastDispatchAt = new Map<TelegramDeliveryClass, number>();
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpScheduled = false;
  private pumpRunning = false;
  private needsPump = false;
  private nextId = 1;
  private nextOrder = 1;

  constructor(policy: Partial<TelegramDeliveryPolicy> = {}, hooks: TelegramDeliverySchedulerHooks = {}) {
    this.policy = {
      ...DEFAULT_TELEGRAM_DELIVERY_POLICY,
      ...policy
    };
    this.hooks = hooks;
  }

  enqueue<T>(operation: TelegramDeliveryOperation<T>): Promise<T | TelegramDeliverySupersededResult> {
    if (operation.replaceable && !operation.coalescingKey) {
      throw new Error("Replaceable telegram deliveries require a coalescingKey.");
    }

    const pending: PendingTelegramDeliveryOperation<T> = {
      id: this.nextId++,
      order: this.nextOrder++,
      operation,
      resolve: () => {},
      reject: () => {}
    };

    const promise = new Promise<T | TelegramDeliverySupersededResult>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });

    this.queueFor(operation.deliveryClass).push(pending);

    if (operation.replaceable && operation.coalescingKey) {
      this.coalescePending(operation.deliveryClass, operation.coalescingKey, pending);
    }

    this.safeInvokeHook(() =>
      this.hooks.onQueued?.({
        deliveryClass: operation.deliveryClass,
        coalescingKey: operation.coalescingKey,
        replaceable: operation.replaceable ?? false
      })
    );

    this.requestPump();
    return promise;
  }

  private queueFor(deliveryClass: TelegramDeliveryClass): Array<PendingTelegramDeliveryOperation<unknown>> {
    const queue = this.queues.get(deliveryClass);
    if (queue) {
      return queue;
    }

    const created: Array<PendingTelegramDeliveryOperation<unknown>> = [];
    this.queues.set(deliveryClass, created);
    return created;
  }

  private coalescePending(
    deliveryClass: TelegramDeliveryClass,
    coalescingKey: string,
    newest: PendingTelegramDeliveryOperation<unknown>
  ): void {
    const key = this.replaceableKey(deliveryClass, coalescingKey);
    const previous = this.replaceablePending.get(key);
    if (!previous) {
      this.replaceablePending.set(key, newest);
      return;
    }

    const queue = this.queueFor(deliveryClass);
    const index = queue.indexOf(previous);
    if (index >= 0) {
      queue.splice(index, 1);
    }

    previous.resolve({
      kind: "telegram_delivery_superseded",
      deliveryClass,
      coalescingKey
    });
    this.safeInvokeHook(() => this.hooks.onCoalesced?.({ deliveryClass, coalescingKey }));
    this.safeInvokeHook(() => this.hooks.onSuperseded?.({ deliveryClass, coalescingKey }));
    this.replaceablePending.set(key, newest);
  }

  private replaceableKey(deliveryClass: TelegramDeliveryClass, coalescingKey: string): string {
    return `${deliveryClass}\u0000${coalescingKey}`;
  }

  private requestPump(): void {
    this.needsPump = true;

    if (this.pumpRunning || this.pumpScheduled) {
      return;
    }

    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.runPump();
    });
  }

  private async runPump(): Promise<void> {
    if (this.pumpRunning) {
      return;
    }

    this.pumpRunning = true;

    try {
      while (true) {
        this.resumeExpiredPauses();
        const next = this.pickNextOperation();
        if (!next) {
          break;
        }

        this.needsPump = false;
        const { pending, replaceableKey } = next;
        const deliveryClass = pending.operation.deliveryClass;
        this.lastDispatchAt.set(deliveryClass, Date.now());

        try {
          const value = await pending.operation.execute();
          if (this.isCurrentReplaceable(replaceableKey, pending)) {
            this.replaceablePending.delete(replaceableKey);
            pending.resolve(value);
          }
        } catch (error) {
          const retryAfterMs = getTelegramRetryAfterMs(error);
          const isCurrentReplaceable = this.isCurrentReplaceable(replaceableKey, pending);
          if (retryAfterMs !== null) {
            this.pauseClass(deliveryClass, retryAfterMs);
            if (isCurrentReplaceable) {
              this.queueFor(deliveryClass).unshift(pending);
            }
            continue;
          }

          if (!isCurrentReplaceable && replaceableKey) {
            continue;
          }

          if (isCurrentReplaceable) {
            this.replaceablePending.delete(replaceableKey);
          }
          pending.reject(error);
          this.safeInvokeHook(() => this.hooks.onFailure?.({ deliveryClass, error }));
        }
      }
    } finally {
      this.pumpRunning = false;
      this.scheduleWakeIfNeeded();
    }
  }

  private pickNextOperation():
    | {
        pending: PendingTelegramDeliveryOperation<unknown>;
        replaceableKey: string | null;
      }
    | null {
    const callbackQueue = this.queues.get("callback_answer");
    const callbackCandidate = callbackQueue?.[0];
    if (callbackCandidate && this.isClassReady("callback_answer")) {
      callbackQueue?.shift();
      return {
        pending: callbackCandidate,
        replaceableKey: callbackCandidate.operation.replaceable && callbackCandidate.operation.coalescingKey
          ? this.replaceableKey("callback_answer", callbackCandidate.operation.coalescingKey)
          : null
      };
    }

    let bestClass: TelegramDeliveryClass | null = null;
    let bestCandidate: PendingTelegramDeliveryOperation<unknown> | null = null;

    for (const deliveryClass of NON_CALLBACK_CLASSES) {
      const queue = this.queues.get(deliveryClass);
      const candidate = queue?.[0];
      if (!candidate || !this.isClassReady(deliveryClass)) {
        continue;
      }

      if (
        !bestCandidate ||
        this.classPriority(deliveryClass) < this.classPriority(bestClass) ||
        (this.classPriority(deliveryClass) === this.classPriority(bestClass) && candidate.order < bestCandidate.order)
      ) {
        bestClass = deliveryClass;
        bestCandidate = candidate;
      }
    }

    if (!bestClass || !bestCandidate) {
      return null;
    }

    this.queues.get(bestClass)?.shift();
    return {
      pending: bestCandidate,
      replaceableKey:
        bestCandidate.operation.replaceable && bestCandidate.operation.coalescingKey
          ? this.replaceableKey(bestClass, bestCandidate.operation.coalescingKey)
          : null
    };
  }

  private isClassReady(deliveryClass: TelegramDeliveryClass): boolean {
    const now = Date.now();
    const pausedUntil = this.pauseUntil.get(deliveryClass);
    if (pausedUntil !== undefined && pausedUntil > now) {
      return false;
    }

    const spacingMs = this.spacingForClass(deliveryClass);
    const lastDispatch = this.lastDispatchAt.get(deliveryClass);
    if (lastDispatch === undefined) {
      return true;
    }

    return now - lastDispatch >= spacingMs;
  }

  private spacingForClass(deliveryClass: TelegramDeliveryClass): number {
    switch (deliveryClass) {
      case "callback_answer":
        return this.policy.callbackAnswerSpacingMs;
      case "visible_send":
        return this.policy.visibleSendSpacingMs;
      case "topic_create":
        return this.policy.topicCreateSpacingMs;
      case "visible_edit":
        return this.policy.visibleEditSpacingMs;
      case "delete":
        return this.policy.deleteSpacingMs;
      case "chat_action":
        return this.policy.chatActionSpacingMs;
    }
  }

  private pauseClass(deliveryClass: TelegramDeliveryClass, retryAfterMs: number): void {
    const effectivePauseMs = Math.max(retryAfterMs, this.backoffForClass(deliveryClass));
    const pauseUntil = Date.now() + effectivePauseMs;
    this.pauseUntil.set(deliveryClass, pauseUntil);
    this.safeInvokeHook(() =>
      this.hooks.onClassPaused?.({
        deliveryClass,
        retryAfterMs,
        effectivePauseMs,
        pauseUntil
      })
    );
  }

  private resumeExpiredPauses(): void {
    const now = Date.now();
    for (const [deliveryClass, pausedUntil] of this.pauseUntil) {
      if (pausedUntil > now) {
        continue;
      }

      this.pauseUntil.delete(deliveryClass);
      this.safeInvokeHook(() => this.hooks.onClassResumed?.({ deliveryClass }));
    }
  }

  private scheduleWakeIfNeeded(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    const wakeAt = this.nextEligibleWakeAt();
    if (wakeAt === null) {
      return;
    }

    const delay = Math.max(0, wakeAt - Date.now());
    if (delay === 0) {
      this.requestPump();
      return;
    }

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.requestPump();
    }, delay);
  }

  private nextEligibleWakeAt(): number | null {
    let earliest: number | null = null;

    for (const deliveryClass of [...NON_CALLBACK_CLASSES, "callback_answer"]) {
      const queue = this.queues.get(deliveryClass);
      const head = queue?.[0];
      if (!head) {
        continue;
      }

      const wakeAt = this.classWakeAt(deliveryClass);
      if (wakeAt <= Date.now()) {
        return Date.now();
      }

      if (earliest === null || wakeAt < earliest) {
        earliest = wakeAt;
      }
    }

    return earliest;
  }

  private classWakeAt(deliveryClass: TelegramDeliveryClass): number {
    const pausedUntil = this.pauseUntil.get(deliveryClass) ?? 0;
    const spacingMs = this.spacingForClass(deliveryClass);
    const lastDispatch = this.lastDispatchAt.get(deliveryClass);
    const spacingUntil = lastDispatch === undefined ? 0 : lastDispatch + spacingMs;
    return Math.max(pausedUntil, spacingUntil);
  }

  private isCurrentReplaceable(
    replaceableKey: string | null,
    pending: PendingTelegramDeliveryOperation<unknown>
  ): boolean {
    if (!replaceableKey) {
      return true;
    }

    return this.replaceablePending.get(replaceableKey) === pending;
  }

  private safeInvokeHook(callback: () => void | undefined): void {
    try {
      callback();
    } catch {
      // Hooks are observability only; scheduler correctness must not depend on them.
    }
  }

  private classPriority(deliveryClass: TelegramDeliveryClass | null): number {
    switch (deliveryClass) {
      case "visible_send":
      case "topic_create":
      case "visible_edit":
        return 1;
      case "delete":
        return 2;
      case "chat_action":
        return 3;
      case "callback_answer":
        return 0;
      case null:
        return Number.POSITIVE_INFINITY;
    }
  }

  private backoffForClass(deliveryClass: TelegramDeliveryClass): number {
    switch (deliveryClass) {
      case "callback_answer":
        return this.policy.callbackAnswerBackoffAfter429Ms;
      case "visible_send":
        return this.policy.visibleSendBackoffAfter429Ms;
      case "topic_create":
        return this.policy.topicCreateBackoffAfter429Ms;
      case "visible_edit":
        return this.policy.visibleEditBackoffAfter429Ms;
      case "delete":
        return this.policy.deleteBackoffAfter429Ms;
      case "chat_action":
        return this.policy.chatActionBackoffAfter429Ms;
    }
  }
}

function getTelegramRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const asRecord = error as Record<string, unknown>;
  const errorCode = Number(asRecord.error_code);
  if (errorCode !== 429) {
    return null;
  }

  const parameters = asRecord.parameters;
  if (parameters && typeof parameters === "object") {
    const retryAfter = Number((parameters as Record<string, unknown>).retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter * 1000;
    }
  }

  const description = typeof asRecord.description === "string" ? asRecord.description : "";
  const match = /retry after (\d+)/i.exec(description);
  if (!match) {
    return null;
  }

  const retryAfter = Number(match[1]);
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) {
    return null;
  }

  return retryAfter * 1000;
}
