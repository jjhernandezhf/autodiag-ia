// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserApiClient, JsonRequestOptions } from "./api-client";
import { HistoryAutomation } from "./HistoryAutomation";
afterEach(cleanup);
function client(enabled = true, send: () => Promise<unknown> = async()=>({status:"completed"})) {
  const calls: AbortSignal[]=[];
  const requestJson=vi.fn(async (url:string, options:JsonRequestOptions<unknown>)=>{
    calls.push(options.init?.signal as AbortSignal);
    const result=options.parse(url.endsWith("capabilities") ? {enabled} : await send());
    if (result === null) throw new Error("invalid"); return result;
  });
  return { api: {requestJson,checkHealth:vi.fn()} as unknown as BrowserApiClient, requestJson,calls };
}
describe("explicit automation",()=>{
  it("disabled hides action and never sends event",async()=>{
    const c=client(false); render(<HistoryAutomation apiClient={c.api} historyId="id-a"/>);
    await waitFor(()=>expect(c.requestJson).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("only explicit click sends no payload and no automatic retry",async()=>{
    const c=client(); render(<HistoryAutomation apiClient={c.api} historyId="id-a"/>);
    fireEvent.click(await screen.findByRole("button"));
    await screen.findByText(/Recepción del evento confirmada/);
    expect(c.requestJson).toHaveBeenCalledTimes(2);
    expect(c.requestJson.mock.calls[1]![0]).toBe("/api/history/id-a/automation");
    expect(c.requestJson.mock.calls[1]![1]).toMatchObject({retry:"none",init:{method:"POST"}});
    expect(c.requestJson.mock.calls[1]![1].init?.body).toBeUndefined();
  });
  it("remote messages remain private, manual retry only",async()=>{
    const c=client(true,async()=>{throw new Error("secret remote text");});
    render(<HistoryAutomation apiClient={c.api} historyId="id-a"/>); fireEvent.click(await screen.findByRole("button"));
    await screen.findByText(/puede haberse recibido/); expect(screen.queryByText(/secret remote/)).toBeNull();
    expect(c.requestJson).toHaveBeenCalledTimes(2);
  });
  it("logout/unmount and identity key changes abort and discard old completion",async()=>{
    let resolve!: (v:unknown)=>void;
    const c=client(true,()=>new Promise(r=>{resolve=r;}));
    const view=render(<HistoryAutomation key="user-a" apiClient={c.api} historyId="id-a"/>);
    fireEvent.click(await screen.findByRole("button"));
    const oldSignal=c.calls[1]!;
    view.rerender(<HistoryAutomation key="user-b" apiClient={c.api} historyId="id-b"/>);
    expect(oldSignal.aborted).toBe(true);
    await act(async()=>resolve({status:"completed"}));
    expect(screen.queryByText(/Recepción del evento confirmada/)).toBeNull();
    view.unmount(); expect(c.calls.every(s=>s.aborted)).toBe(true);
  });
});
