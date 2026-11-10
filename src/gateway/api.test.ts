import test from "node:test";
import assert from "node:assert/strict";
import { NaNApi, type NaNApiDeps } from "./api.js";
import { ProviderError } from "../errors.js";

function sseResponse(blocks: string[], status = 200, headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(body, { status, headers });
}

function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function apiWith(calls: Array<(url: string, init: RequestInit) => Promise<Response>>, key = "k-test"): NaNApi {
  let index = 0;
  const deps: NaNApiDeps = {
    key: async () => key,
    baseUrl: () => "https://nan.test/v1",
    userAgent: () => "test/1.0",
    connectTimeoutMs: () => 1000,
    idleTimeoutMs: () => 1000,
    fetcher: ((url: string, init: RequestInit) => {
      const handler = calls[Math.min(index, calls.length - 1)];
      index += 1;
      return handler(url, init);
    }) as unknown as typeof fetch,
  };
  return new NaNApi(deps);
}

const CHAT = {
  model: "glm5.3-flash",
  messages: [{ role: "user", content: "hi" }],
  stream: true as const,
};

test("streams decoded events and releases the slot at the end", async () => {
  let activeDuringStream = -1;
  const api = apiWith([
    async () =>
      sseResponse([
        data({ choices: [{ delta: { content: "hello" } }] }),
        "data: [DONE]\n\n",
      ]),
  ]);
  const events = await api.openChat(CHAT);
  for await (const event of events) {
    if (event.kind === "text") activeDuringStream = 1;
  }
  assert.equal(activeDuringStream, 1);
  // Slot is free again: a second chat goes straight through.
  const second = await api.openChat(CHAT);
  await second.next();
  await second.return(undefined as never);
});

test("retries a 429 with a short Retry-After once, then succeeds", async () => {
  const seen: number[] = [];
  const api = apiWith([
    async () => {
      seen.push(429);
      return sseResponse(['{"error":{"code":"rate_limit_exceeded","message":"slow down"}}'], 429, { "retry-after": "0" });
    },
    async () => {
      seen.push(200);
      return sseResponse([data({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"]);
    },
  ]);
  const events = await api.openChat(CHAT);
  const kinds: string[] = [];
  for await (const event of events) kinds.push(event.kind);
  assert.deepEqual(seen, [429, 200]);
  assert.ok(kinds.includes("text"));
});

test("gives up immediately when Retry-After is too long to honor", async () => {
  const api = apiWith([
    async () => sseResponse(['{"error":{"code":"rate_limit_exceeded","message":"cap"}}'], 429, { "retry-after": "60" }),
  ]);
  await assert.rejects(api.openChat(CHAT), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "rate_limit_exceeded");
    return true;
  });
});

test("surfaces missing keys as an auth error, not a network error", async () => {
  const api = apiWith([async () => sseResponse([])], "");
  await assert.rejects(api.openChat(CHAT), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "invalid_api_key");
    return true;
  });
});

test("listModels parses the JSON directory", async () => {
  const api = apiWith([async () => new Response(JSON.stringify({ data: [{ id: "glm5.3-flash" }] }), { status: 200 })]);
  const payload = (await api.listModels()) as { data: Array<{ id: string }> };
  assert.equal(payload.data[0].id, "glm5.3-flash");
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

test("fetchUsage follows the cursor while the newest day spills over pages", async () => {
  const page1 = {
    object: "usage.report", start_date: "2026-10-10", end_date: "2026-11-09",
    has_more: true, next_cursor: "c2",
    data: [{ date: "2026-11-08", model: "glm5.3-flash" }, { date: "2026-11-09", model: "deepseek-v4-flash" }],
  };
  const page2 = {
    object: "usage.report", end_date: "2026-11-09", has_more: false,
    data: [{ date: "2026-11-09", model: "glm5.3-flash" }],
  };
  const urls: string[] = [];
  const api = apiWith([
    (url) => { urls.push(url); return Promise.resolve(jsonResponse(page1)); },
    (url) => { urls.push(url); return Promise.resolve(jsonResponse(page2)); },
  ]);
  const report = (await api.fetchUsage()) as { data: Array<{ date: string; model: string }> };
  assert.match(urls[0], /\/usage$/);
  assert.match(urls[1], /\/usage\?cursor=c2/);
  assert.equal(report.data.length, 3);
  assert.ok(report.data.some((row) => row.date === "2026-11-09" && row.model === "glm5.3-flash"));
  assert.equal(new Set(report.data.map((row) => `${row.date}|${row.model}`)).size, 3); // dedup key complete
});

test("fetchUsage stops after one page when the cursor is absent", async () => {
  const page = { object: "usage.report", end_date: "2026-11-09", has_more: false, data: [{ date: "2026-11-09", model: "gemma4" }] };
  let calls = 0;
  const api = apiWith([() => { calls += 1; return Promise.resolve(jsonResponse(page)); }]);
  const report = (await api.fetchUsage()) as { data: Array<{ date: string }> };
  assert.equal(calls, 1);
  assert.equal(report.data.length, 1);
});
