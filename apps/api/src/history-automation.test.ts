import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { automationConfig, AutomationBudget, HistoryAutomation, type EventStatus } from "./history-automation.js";
import { createApp } from "./app.js";
import { DiagnosticHistoryService, DiagnosticHistoryError } from "./diagnostic-history.js";
const user = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const config = { url: "https://webhook.example.test/hook", outboundToken: "a".repeat(40), callbackToken: "b".repeat(40), idKey: "c".repeat(40), signingKey: "d".repeat(40) };
function setup() {
  const rows = new Map<string, EventStatus>();
  const transition = vi.fn(async (key: string, operation: string) => {
    if (operation === "register" && !rows.has(key)) rows.set(key, "received");
    if (!rows.has(key)) throw new Error("missing");
    if (operation === "complete" && rows.get(key) === "received") rows.set(key, "completed");
    if (operation === "fail" && rows.get(key) === "received") rows.set(key, "failed");
    return rows.get(key)!;
  });
  const transport = vi.fn<typeof fetch>(async (_url, init) => { const event = JSON.parse(String(init?.body)); rows.set(event.eventId, "completed"); return new Response(null, {status:200}); });
  const service = new HistoryAutomation(config, { transition }, transport, () => Date.parse("2026-10-20T12:00:00.000Z"));
  return { service, transport, transition, rows };
}
describe("automation disconnected", () => {
  it("disabled default and strict config", () => {
    expect(automationConfig({})).toBeUndefined();
    expect(() => automationConfig({AUTOMATION_ENABLED:"yes"})).toThrow();
    const env = {AUTOMATION_ENABLED:"true",AUTOMATION_WEBHOOK_URL:config.url,AUTOMATION_OUTBOUND_TOKEN:config.outboundToken,AUTOMATION_CALLBACK_TOKEN:config.callbackToken,AUTOMATION_ID_KEY:config.idKey,AUTOMATION_SIGNING_KEY:config.signingKey};
    expect(automationConfig(env)).toEqual(config);
    for (const url of ["http://example.test", "https://user:pass@example.test", "https://example.test?a=b"]) expect(() => automationConfig({...env,AUTOMATION_WEBHOOK_URL:url})).toThrow();
    expect(() => automationConfig({...env,VIN_HMAC_SECRET:config.idKey})).toThrow();
  });
  it("minimal deterministic identity, separate users and no redirects/retries", async () => {
    const {service,transport}=setup(); const event=service.event(user,id);
    expect(Object.keys(event).sort()).toEqual(["eventId","issuedAt","schemaVersion","type"]);
    expect(JSON.stringify(event)).not.toContain(user); expect(JSON.stringify(event)).not.toContain(id);
    expect(service.event(user,id)).toEqual(event); expect(service.event(id,id).eventId).not.toBe(event.eventId);
    await Promise.all([service.send(event,new AbortController().signal),service.send(event,new AbortController().signal)]);
    expect(transport).toHaveBeenCalledTimes(2); expect(transport.mock.calls[0]![1]?.redirect).toBe("error");
    transport.mockRejectedValueOnce(new Error("private provider text"));
    await expect(service.send(event,new AbortController().signal)).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(3);
    transport.mockResolvedValueOnce(new Response(null,{status:401}));
    await expect(service.send(event,new AbortController().signal)).rejects.toThrow("AUTOMATION_UNAVAILABLE");
  });
  it("signatures, expiry, duplicates and terminal state (mock, not SQL proof)", async () => {
    const {service,rows}=setup(); const event=service.event(user,id), sig=service.signature(event), signal=new AbortController().signal;
    expect(() => service.verify(event,"wrong",sig)).toThrow();
    expect(() => service.verify({...event,type:"other"},config.callbackToken,sig)).toThrow();
    const expired={...event,issuedAt:"2026-10-20T11:00:00.000Z"};
    expect(() => service.verify(expired,config.callbackToken,service.signature(expired))).toThrow();
    await Promise.all(Array.from({length:5},()=>service.callback(event,config.callbackToken,sig,"register",signal)));
    expect(rows.size).toBe(1);
    await service.callback(event,config.callbackToken,sig,"complete",signal);
    expect(await service.callback(event,config.callbackToken,sig,"fail",signal)).toBe("completed");
  });
  it("timeout observes late rejection and retains physical capacity", async () => {
    vi.useFakeTimers();
    try {
      const budget=new AutomationBudget(); const rejectors: Array<(e: Error)=>void>=[];
      const jobs=Array.from({length:4},()=>budget.run(()=>new Promise<void>((_,reject)=>rejectors.push(reject)),10).catch(e=>e.code));
      await vi.advanceTimersByTimeAsync(11); expect(await Promise.all(jobs)).toEqual(Array(4).fill("AUTOMATION_RESULT_UNKNOWN"));
      await expect(budget.run(async()=>1)).rejects.toThrow("AUTOMATION_BUSY");
      rejectors.forEach(reject=>reject(new Error("late"))); await vi.advanceTimersByTimeAsync(0);
      expect(await budget.run(async()=>1)).toBe(1);
    } finally {vi.useRealTimers();}
  });
  it("routes require session and ownership; disabled and callbacks protected", async () => {
    const {service,transport}=setup();
    const get=vi.fn(async()=> {throw new DiagnosticHistoryError("HISTORY_NOT_FOUND");});
    const app=createApp({vinHmacSecret:"synthetic-secret-at-least-32-characters",automation:service,
      historyService:{get} as unknown as DiagnosticHistoryService,
      authenticationService:{authenticate:async()=>({id:user,username:"synthetic"}),login:async()=>{throw new Error();}}});
    expect((await request(app).post(`/api/history/${id}/automation`)).status).toBe(401);
    expect((await request(app).post(`/api/history/${id}/automation`).set("Authorization","Bearer synthetic")).status).toBe(404);
    expect(get.mock.calls[0]?.[0]).toBe(user); expect(transport).not.toHaveBeenCalled();
    expect((await request(app).post("/api/internal/automation/register").send(service.event(user,id))).status).toBe(401);
    const disabled=createApp({vinHmacSecret:"synthetic-secret-at-least-32-characters"});
    expect((await request(disabled).post("/api/internal/automation/register")).status).toBe(503);
  });
  it("SQL/workflow are prepared only; no credentials or privileged workflow", () => {
    const sql=readFileSync(new URL("../../../supabase/migrations/20261020000100_create_automation_events.sql",import.meta.url),"utf8");
    expect(sql).toContain("force row level security"); expect(sql).toContain("rolbypassrls"); expect(sql).toContain("security invoker"); expect(sql).toContain("for update"); expect(sql).toContain("on conflict (event_id) do nothing");
    const workflow=JSON.parse(readFileSync(new URL("../../../automation/n8n/diagnostic-event.workflow.json",import.meta.url),"utf8"));
    expect(workflow.active).toBe(false); expect(JSON.stringify(workflow)).not.toContain("service_role");
    expect(workflow.nodes.every((n: {credentials?:unknown})=>!n.credentials)).toBe(true);
  });
  it("owned route sends only minimal event, keeps history unchanged and enforces quota", async () => {
    const {service,transport}=setup();
    const get=vi.fn(async()=>({id}));
    const app=createApp({vinHmacSecret:"synthetic-secret-at-least-32-characters",automation:service,
      historyService:{get} as unknown as DiagnosticHistoryService,
      authenticationService:{authenticate:async()=>({id:user,username:"synthetic"}),login:async()=>{throw new Error();}}});
    const auth = (path:string)=>request(app).post(path).set("Authorization","Bearer synthetic");
    expect((await request(app).get("/api/automation/capabilities").set("Authorization","Bearer synthetic")).body).toEqual({enabled:true});
    const path=`/api/history/${id}/automation`;
    const response=await auth(path);
    expect(response.status).toBe(200); expect(response.body).toEqual({status:"completed"});
    expect(get).toHaveBeenCalledWith(user,id,expect.any(AbortSignal));
    expect(Object.keys(JSON.parse(String(transport.mock.calls[0]![1]?.body))).sort()).toEqual(["eventId","issuedAt","schemaVersion","type"]);
    expect(response.headers["cache-control"]).toContain("no-store");
    for(let i=0;i<9;i++) expect((await auth(path)).status).toBe(200);
    expect((await auth(path)).status).toBe(429); expect(transport).toHaveBeenCalledTimes(10);
  });
  it("callback cannot recover, rejects oversized/altered events, accepts signed completion",async()=>{
    const {service}=setup();
    const app=createApp({vinHmacSecret:"synthetic-secret-at-least-32-characters",automation:service});
    const event=service.event(user,id);
    const call=(op:string,body:unknown=event)=>request(app).post(`/api/internal/automation/${op}`)
      .set("X-Automation-Callback",config.callbackToken).set("X-Autodiag-Signature",service.signature(event)).send(body as object);
    expect((await call("recover")).status).toBe(400);
    expect((await call("register",{...event,eventId:"automation_v1_"+"0".repeat(64)})).status).toBe(401);
    expect((await call("register",{...event,extra:"x".repeat(2000)})).status).toBe(413);
    expect((await call("register")).body).toEqual({status:"received"});
    expect((await call("complete")).body).toEqual({status:"completed"});
    expect((await call("complete")).body).toEqual({status:"completed"});
  });
  it("valid webhook response without durable completion is unknown, not success",async()=>{
    const {service,transport}=setup();
    transport.mockResolvedValue(new Response(null,{status:200}));
    await expect(service.send(service.event(user,id),new AbortController().signal)).rejects.toThrow("AUTOMATION_RESULT_UNKNOWN");
  });
});
