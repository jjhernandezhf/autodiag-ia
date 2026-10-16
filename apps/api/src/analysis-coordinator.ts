import { createHash } from "node:crypto";

import { z } from "zod";

export type AnalysisCoordinationErrorCode =
  | "ANALYSIS_TIMEOUT"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "ANALYSIS_CAPACITY_EXCEEDED";

export class AnalysisCoordinationError extends Error {
  constructor(public readonly code: AnalysisCoordinationErrorCode) {
    super(code);
    this.name = "AnalysisCoordinationError";
  }
}

class AnalysisTimeoutArbiter {
  private active?: { deadlineAtMs: number; ownError: () => Error };
  private attributed?: { attempt: object; error: Error };

  constructor(private readonly integralDeadlineAtMs: number) {}

  register(deadlineAtMs: number, ownError: () => Error) {
    const attempt = { deadlineAtMs, ownError };
    this.active = attempt;
    this.attributed = undefined;
    return {
      error: (providerTimeout?: Error) => {
        const error = deadlineAtMs < this.integralDeadlineAtMs
          ? providerTimeout ?? ownError()
          : new AnalysisCoordinationError("ANALYSIS_TIMEOUT");
        // Late settlement of an old physical attempt cannot overwrite a successor.
        if (this.active === attempt) this.attributed = { attempt, error };
        return error;
      },
      finish: () => { if (this.active === attempt) this.active = undefined; },
      resume: () => {
        if (this.attributed?.attempt === attempt) this.attributed = undefined;
      },
    };
  }

  error() {
    if (this.attributed) return this.attributed.error;
    if (this.active && this.active.deadlineAtMs < this.integralDeadlineAtMs) {
      const error = this.active.ownError();
      this.attributed = { attempt: this.active, error };
      return error;
    }
    return new AnalysisCoordinationError("ANALYSIS_TIMEOUT");
  }
}

const timeoutArbiters = new WeakMap<AbortSignal, AnalysisTimeoutArbiter>();

export function registerAnalysisAttemptTimeout(
  signal: AbortSignal | undefined,
  integralDeadlineAtMs: number | undefined,
  attemptDeadlineAtMs: number,
  ownError: () => Error,
) {
  const arbiter = (signal && timeoutArbiters.get(signal))
    || new AnalysisTimeoutArbiter(integralDeadlineAtMs ?? Number.POSITIVE_INFINITY);
  return arbiter.register(attemptDeadlineAtMs, ownError);
}

export function assertAnalysisDeadline(signal: AbortSignal | undefined, deadlineAtMs: number, now: () => number = Date.now) {
  signal?.throwIfAborted();
  if (now() >= deadlineAtMs) {
    throw (signal && timeoutArbiters.get(signal)?.error()) || new AnalysisCoordinationError("ANALYSIS_TIMEOUT");
  }
}

const idempotencyKeySchema = z.string().uuid().transform((value) => value.toLowerCase());

export function parseAnalysisIdempotencyKey(value: unknown) {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) throw new AnalysisCoordinationError("IDEMPOTENCY_KEY_INVALID");
  return parsed.data;
}

export function fingerprintAnalysisRequest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface SharedAnalysisOperation<T> {
  result: Promise<T>;
  drained: Promise<void>;
}

interface AnalysisBudgetDependencies {
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  now?: () => number;
}

export function runWithAnalysisBudget<T>(
  operation: (
    signal: AbortSignal,
    deadlineAtMs: number,
    observePhysical: (work: Promise<unknown>) => void,
  ) => Promise<T>,
  timeoutMs: number,
  dependencies: AnalysisBudgetDependencies = {},
): SharedAnalysisOperation<T> {
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;
  const now = dependencies.now ?? Date.now;
  const controller = new AbortController();
  const deadlineAtMs = now() + timeoutMs;
  const timeoutArbiter = new AnalysisTimeoutArbiter(deadlineAtMs);
  timeoutArbiters.set(controller.signal, timeoutArbiter);
  const pendingPhysical: Promise<void>[] = [];
  const observePhysical = (work: Promise<unknown>) => {
    pendingPhysical.push(work.then(() => undefined, () => undefined));
  };
  const physical = Promise.resolve()
    .then(() => operation(controller.signal, deadlineAtMs, observePhysical))
    .then((value) => {
      assertAnalysisDeadline(controller.signal, deadlineAtMs, now);
      return value;
    });
  // The provider may ignore AbortSignal. Keep a permanent rejection observer
  // while its physical work drains so a logical timeout cannot orphan it.
  const drained = physical.then(() => undefined, () => undefined)
    .then(async () => { await Promise.all(pendingPhysical); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimer(() => {
      const error = timeoutArbiter.error();
      controller.abort(error);
      reject(error);
    }, Math.max(0, deadlineAtMs - now()));
  });
  const result = Promise.race([physical, timeout]).finally(() => {
    if (timer !== undefined) clearTimer(timer);
  });
  void result.then(() => undefined, () => undefined);
  return { result, drained };
}

interface CoordinatorOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface CoordinatorEntry<T> {
  result: Promise<T>;
  expiresAt: number;
  active: boolean;
}

interface IdempotencyKeyBinding {
  fingerprint: string;
  expiresAt: number;
}

export class AnalysisIdempotencyCoordinator<T> {
  private readonly entries = new Map<string, CoordinatorEntry<T>>();
  private readonly keyBindings = new Map<string, IdempotencyKeyBinding>();
  private readonly now: () => number;

  constructor(private readonly options: CoordinatorOptions) {
    z.number().int().min(1).max(24 * 60 * 60_000).parse(options.ttlMs);
    z.number().int().min(1).max(10_000).parse(options.maxEntries);
    this.now = options.now ?? Date.now;
  }

  get size() {
    return this.entries.size;
  }

  sweep() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (!entry.active && entry.expiresAt <= now) this.entries.delete(key);
    }
    for (const [key, binding] of this.keyBindings) {
      const userId = key.slice(0, key.indexOf(":"));
      const entry = this.entries.get(`${userId}:${binding.fingerprint}`);
      if (!entry?.active && binding.expiresAt <= now) this.keyBindings.delete(key);
    }
  }

  execute(
    userId: string,
    key: string,
    fingerprint: string,
    start: () => SharedAnalysisOperation<T>,
  ): Promise<T> {
    this.sweep();
    const scopedKey = `${userId}:${key}`;
    const scopedFingerprint = `${userId}:${fingerprint}`;
    const binding = this.keyBindings.get(scopedKey);
    if (binding && binding.fingerprint !== fingerprint) {
      throw new AnalysisCoordinationError("IDEMPOTENCY_CONFLICT");
    }
    const existing = this.entries.get(scopedFingerprint);
    if (existing) {
      if (!binding) {
        if (this.keyBindings.size >= this.options.maxEntries) {
          throw new AnalysisCoordinationError("ANALYSIS_CAPACITY_EXCEEDED");
        }
        this.keyBindings.set(scopedKey, { fingerprint, expiresAt: existing.expiresAt });
      }
      return existing.result;
    }
    if (this.entries.size >= this.options.maxEntries || this.keyBindings.size >= this.options.maxEntries) {
      throw new AnalysisCoordinationError("ANALYSIS_CAPACITY_EXCEEDED");
    }

    const operation = start();
    const entry: CoordinatorEntry<T> = {
      result: operation.result,
      expiresAt: Number.POSITIVE_INFINITY,
      active: true,
    };
    this.entries.set(scopedFingerprint, entry);
    this.keyBindings.set(scopedKey, { fingerprint, expiresAt: entry.expiresAt });
    const finish = async (succeeded: boolean) => {
      // Logical timeout never releases a physically active operation.
      await operation.drained.catch(() => undefined);
      if (this.entries.get(scopedFingerprint) !== entry) return;
      entry.active = false;
      if (!succeeded) this.entries.delete(scopedFingerprint);
      entry.expiresAt = this.now() + this.options.ttlMs;
      for (const [bindingKey, bindingEntry] of this.keyBindings) {
        if (bindingEntry.fingerprint === fingerprint && bindingKey.startsWith(`${userId}:`)) {
          if (succeeded) bindingEntry.expiresAt = entry.expiresAt;
          else this.keyBindings.delete(bindingKey);
        }
      }
    };
    void operation.result.then(() => finish(true), () => finish(false));
    return entry.result;
  }
}
