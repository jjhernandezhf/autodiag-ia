import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

export const eventSchema = z.object({ schemaVersion: z.literal(1), type: z.literal("diagnostic.saved.requested"),
  eventId: z.string().regex(/^automation_v1_[0-9a-f]{64}$/u), issuedAt: z.string().datetime().max(40) }).strict();
export type AutomationEvent = z.infer<typeof eventSchema>;
export type EventStatus = "received" | "completed" | "failed";
const statusSchema = z.enum(["received", "completed", "failed"]);
export class AutomationError extends Error {
  constructor(public readonly code: string, public readonly status = 503) { super(code); }
}
export interface AutomationConfig { url: string; outboundToken: string; callbackToken: string; idKey: string; signingKey: string }
export function automationConfig(env: NodeJS.ProcessEnv): AutomationConfig | undefined {
  if (env.AUTOMATION_ENABLED === undefined || env.AUTOMATION_ENABLED === "false" || env.AUTOMATION_ENABLED.trim() === "") return undefined;
  if (env.AUTOMATION_ENABLED !== "true") throw new Error("AUTOMATION_CONFIG_INVALID");
  const secret = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/u);
  const values = z.object({ url: z.string().url(), outboundToken: secret, callbackToken: secret, idKey: secret, signingKey: secret }).parse({
    url: env.AUTOMATION_WEBHOOK_URL, outboundToken: env.AUTOMATION_OUTBOUND_TOKEN,
    callbackToken: env.AUTOMATION_CALLBACK_TOKEN, idKey: env.AUTOMATION_ID_KEY, signingKey: env.AUTOMATION_SIGNING_KEY,
  });
  const url = new URL(values.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.hostname === "localhost" ||
      new Set([values.outboundToken, values.callbackToken, values.idKey, values.signingKey]).size !== 4 ||
      [values.idKey, values.signingKey].includes(env.VIN_HMAC_SECRET ?? "")) throw new Error("AUTOMATION_CONFIG_INVALID");
  return values;
}
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function canonical(e: AutomationEvent) { return JSON.stringify([e.schemaVersion, e.type, e.eventId, e.issuedAt]); }
export interface EventRepository { transition(eventId: string, operation: "register" | "complete" | "fail", signal: AbortSignal): Promise<EventStatus> }
export class SupabaseEventRepository implements EventRepository {
  constructor(private client: SupabaseClient) {}
  async transition(eventId: string, operation: "register" | "complete" | "fail", signal: AbortSignal) {
    const { data, error } = await this.client.rpc("automation_event_transition", { p_event_id: eventId, p_operation: operation }).abortSignal(signal);
    if (error) throw new AutomationError("AUTOMATION_UNAVAILABLE");
    return statusSchema.parse(data);
  }
}
export class HistoryAutomation {
  constructor(readonly config: AutomationConfig, private repository: EventRepository, private transport: typeof fetch = fetch, private now = Date.now) {}
  event(userId: string, historyId: string): AutomationEvent {
    z.string().uuid().parse(userId); z.string().uuid().parse(historyId);
    return { schemaVersion: 1, type: "diagnostic.saved.requested", eventId: "automation_v1_" + createHmac("sha256", this.config.idKey)
      .update(JSON.stringify([1, userId, historyId, "diagnostic.saved.requested"])).digest("hex"), issuedAt: new Date(this.now()).toISOString() };
  }
  signature(event: AutomationEvent) { return createHmac("sha256", this.config.signingKey).update(canonical(event)).digest("hex"); }
  verify(value: unknown, token: string, signature: string) {
    if (!equal(token, this.config.callbackToken)) throw new AutomationError("AUTOMATION_UNAUTHORIZED", 401);
    const parsed = eventSchema.safeParse(value);
    if (!parsed.success) throw new AutomationError("AUTOMATION_INVALID", 400);
    const event = parsed.data, age = this.now() - Date.parse(event.issuedAt);
    if (!/^[0-9a-f]{64}$/u.test(signature) || !equal(signature, this.signature(event)) || age < -30_000 || age > 300_000) {
      throw new AutomationError("AUTOMATION_UNAUTHORIZED", 401);
    }
    return event;
  }
  async callback(value: unknown, token: string, signature: string, operation: "register" | "complete" | "fail", signal: AbortSignal) {
    const event = this.verify(value, token, signature);
    return this.repository.transition(event.eventId, operation, signal);
  }
  async send(event: AutomationEvent, signal: AbortSignal) {
    const response = await this.transport(this.config.url, { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.config.outboundToken}`, "X-Autodiag-Signature": this.signature(event) }, body: JSON.stringify(event) });
    // Provider response is deliberately ignored. The durable receiver state is authoritative.
    await response.body?.cancel();
    if (!response.ok) throw new AutomationError("AUTOMATION_UNAVAILABLE");
    const status = await this.repository.transition(event.eventId, "register", signal);
    if (status !== "completed") throw new AutomationError("AUTOMATION_RESULT_UNKNOWN", 504);
    return { status: "completed" as const };
  }
}

// Physical capacity is retained until the underlying promise settles, even if
// the logical timeout wins. Late rejections remain observed by Promise.race.
export class AutomationBudget {
  private active = 0;
  async run<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = 10_000): Promise<T> {
    if (this.active >= 4) throw new AutomationError("AUTOMATION_BUSY", 429);
    this.active++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const physical = Promise.resolve().then(() => work(controller.signal)).finally(() => { this.active--; });
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new AutomationError("AUTOMATION_RESULT_UNKNOWN", 504));
    }, timeoutMs); });
    try { return await Promise.race([physical, timeout]); } finally { clearTimeout(timer); }
  }
}
