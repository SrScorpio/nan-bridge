import test from "node:test";
import assert from "node:assert/strict";
import { httpFetch } from "./http.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function okStream(chunks: string[]): Response {
  return new Response(streamOf(chunks), { status: 200 });
}

const base = {
  url: "https://nan.test/v1/x",
  method: "GET" as const,
  headers: {},
  connectTimeoutMs: 1000,
  idleTimeoutMs: 1000,
};

test("concatenates body chunks as text", async () => {
  const result = await httpFetch({ ...base, fetcher: (async () => okStream(["a", "b"])) as typeof fetch });
  let text = "";
  for await (const chunk of result.chunks()) text += chunk;
  assert.equal(text, "ab");
  assert.equal(result.status, 200);
});

test("connect timeout aborts before headers", async () => {
  const never: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  await assert.rejects(
    httpFetch({ ...base, connectTimeoutMs: 20, fetcher: never }),
    /connect timeout/i,
  );
});

test("error responses are readable via text()", async () => {
  const result = await httpFetch({
    ...base,
    fetcher: (async () => new Response("boom", { status: 429 })) as typeof fetch,
  });
  assert.equal(result.status, 429);
  assert.equal(await result.text(), "boom");
});

test("streaming stays open across chunks then disposes", async () => {
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("one"));
      controller.enqueue(encoder.encode("two"));
      controller.close();
      closed = true;
    },
  });
  const result = await httpFetch({ ...base, fetcher: (async () => new Response(stream)) as typeof fetch });
  const seen: string[] = [];
  for await (const chunk of result.chunks()) seen.push(chunk);
  assert.deepEqual(seen, ["one", "two"]);
  assert.ok(closed);
  result.dispose(); // idempotent
});
