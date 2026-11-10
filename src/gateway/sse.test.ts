import test from "node:test";
import assert from "node:assert/strict";
import { SseDecoder } from "./sse.js";

function block(payload: unknown): string {
  return `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
}

test("a block split across two pushes survives the buffer boundary", () => {
  const decoder = new SseDecoder();
  const json = JSON.stringify({ choices: [{ delta: { content: "héllo 🚀" } }] });
  const wire = block(json);
  const cut = Math.floor(wire.length / 2);
  const events = [...decoder.push(wire.slice(0, cut)), ...decoder.push(wire.slice(cut))];
  assert.deepEqual(events, [{ kind: "text", value: "héllo 🚀" }]);
});

test("non-finite usage counters from the gateway count as zero", () => {
  const decoder = new SseDecoder();
  const events = decoder.push(
    block({ choices: [{ delta: {} }], usage: { prompt_tokens: "12", completion_tokens: null, prompt_tokens_details: { cached_tokens: Number.NaN } } }),
  );
  assert.deepEqual(events, [{ kind: "usage", promptTokens: 0, completionTokens: 0, cachedTokens: 0 }]);
});

test("emits text deltas as they arrive", () => {
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push(block({ choices: [{ delta: { content: "hel" } }] })), [
    { kind: "text", value: "hel" },
  ]);
  assert.deepEqual(decoder.push(block({ choices: [{ delta: { content: "lo" } }] })), [
    { kind: "text", value: "lo" },
  ]);
});

test("reassembles tool calls from id-bearing and tail fragments", () => {
  const decoder = new SseDecoder();
  const events = [
    ...decoder.push(block({ choices: [{ delta: { tool_calls: [{ id: "t1", function: { name: "list_dir", arguments: "" } }] } }] })),
    ...decoder.push(block({ choices: [{ delta: { tool_calls: [{ function: { arguments: '{"path":' } }] } }] })),
    ...decoder.push(block({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"."}' } }] } }] })),
  ];
  assert.deepEqual(events.filter((event) => event.kind !== "text"), [
    { kind: "tool-start", id: "t1", name: "list_dir" },
    { kind: "tool-args", id: "t1", value: '{"path":' },
    { kind: "tool-args", id: "t1", value: '"."}' },
  ]);
});

test("carries reasoning, finish reason and usage", () => {
  const decoder = new SseDecoder();
  const events = decoder.push(
    block({ choices: [{ delta: { reasoning_content: "thinking…" }, finish_reason: null }] }) +
      block({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } } }) +
      "data: [DONE]\n\n",
  );
  assert.deepEqual(events, [
    { kind: "reasoning", value: "thinking…" },
    { kind: "finish", reason: "tool_calls" },
    { kind: "usage", promptTokens: 10, completionTokens: 4, cachedTokens: 6 },
  ]);
  assert.deepEqual(decoder.close(), []);
});

test("close() flags streams that never sent [DONE]", () => {
  const decoder = new SseDecoder();
  decoder.push(block({ choices: [{ delta: { content: "partial" } }] }));
  const tail = decoder.close();
  assert.equal(tail.filter((event) => event.kind === "protocol-error").length, 1);
});

test("reports unparseable blocks instead of throwing", () => {
  const decoder = new SseDecoder();
  const events = decoder.push("data: {not json}\n\n");
  assert.equal(events[0].kind, "protocol-error");
});

test("splits blocks across chunk boundaries", () => {
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push(block({ choices: [{ delta: { content: "a" } }] }).slice(0, 20)), []);
  const rest = decoder.push(block({ choices: [{ delta: { content: "a" } }] }).slice(20) + block({ choices: [{ delta: { content: "b" } }] }));
  assert.deepEqual(
    rest.map((event) => (event.kind === "text" ? event.value : event)),
    ["a", "b"],
  );
});
