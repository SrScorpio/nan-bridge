import test from "node:test";
import assert from "node:assert/strict";
import { ResponseProjector, type PartConstructors } from "./outbound.js";
import type { SseEvent } from "../gateway/sse.js";

/** Records every projected part so assertions can inspect the sequence. */
function parts() {
  const reported: Array<{ kind: string; [key: string]: unknown }> = [];
  const constructors = {
    text: function (this: unknown, value: string) {
      return { kind: "text", value };
    } as never as PartConstructors["text"],
    thinking: function (this: unknown, value: string, _id?: string, metadata?: Record<string, unknown>) {
      return { kind: "thinking", value, done: Boolean(metadata?.vscode_reasoning_done) };
    } as never as PartConstructors["thinking"],
    toolCall: function (this: unknown, id: string, name: string, args: Record<string, unknown>) {
      return { kind: "toolCall", id, name, args };
    } as never as PartConstructors["toolCall"],
    data: function (this: unknown, value: Uint8Array, id?: string) {
      return { kind: "data", id, json: JSON.parse(new TextDecoder().decode(value)) };
    } as never as PartConstructors["data"],
  };
  return { reported, constructors };
}

const USAGE = { kind: "usage" as const, promptTokens: 10, completionTokens: 20, cachedTokens: 0 };

test("text closes an open thinking segment", () => {
  const { reported, constructors } = parts();
  const projector = new ResponseProjector({ report: (part) => reported.push(part as never) }, constructors);
  projector.handle({ kind: "reasoning", value: "thinking…" });
  projector.handle({ kind: "text", value: "answer" });
  assert.deepEqual(reported.map((part) => part.kind), ["thinking", "thinking", "text"]);
  assert.equal((reported[1] as unknown as { done: boolean }).done, true);
});

test("tool calls assemble from fragments and flush with restored names", () => {
  const { reported, constructors } = parts();
  const projector = new ResponseProjector(
    { report: (part) => reported.push(part as never) },
    constructors,
    undefined,
    (name) => (name === "vscode_read_file" ? "vscode/read-file" : name),
  );
  projector.handle({ kind: "tool-start", id: "c1", name: "vscode_read_file" });
  projector.handle({ kind: "tool-args", id: "c1", value: '{"pa' });
  projector.handle({ kind: "tool-args", id: "c1", value: 'th":"a.ts"}' });
  projector.handle({ kind: "finish", reason: "tool_calls" });
  assert.equal(reported.length, 1);
  const call = reported[0] as { kind: string; id: string; name: string; args: Record<string, unknown> };
  assert.equal(call.id, "c1");
  assert.equal(call.name, "vscode/read-file");
  assert.deepEqual(call.args, { path: "a.ts" });
});

test("args for an unknown call id are dropped, not misattributed", () => {
  const { reported, constructors } = parts();
  const projector = new ResponseProjector({ report: (part) => reported.push(part as never) }, constructors);
  projector.handle({ kind: "tool-args", id: "ghost", value: "{}" });
  projector.handle({ kind: "finish", reason: "stop" });
  assert.equal(reported.length, 0);
});

test("settle flushes tool calls that arrive without a finish", () => {
  const { reported, constructors } = parts();
  const projector = new ResponseProjector({ report: (part) => reported.push(part as never) }, constructors);
  projector.handle({ kind: "tool-start", id: "c2", name: "list_dir" });
  projector.handle({ kind: "tool-args", id: "c2", value: "{}" });
  projector.settle();
  assert.equal(reported.length, 1);
  // Double settle must not duplicate the call.
  projector.settle();
  assert.equal(reported.length, 1);
});

test("usage reports through onUsage and a data part with snake_case", () => {
  const { reported, constructors } = parts();
  let seen: unknown;
  const projector = new ResponseProjector(
    { report: (part) => reported.push(part as never) },
    constructors,
    (usage) => {
      seen = usage;
    },
  );
  projector.handle(USAGE);
  assert.deepEqual(seen, { promptTokens: 10, completionTokens: 20, cachedTokens: 0 });
  const data = reported.find((part) => part.kind === "data") as unknown as { json: Record<string, number> };
  assert.deepEqual(data.json, { prompt_tokens: 10, completion_tokens: 20, cached_tokens: 0 });
});

test("invalid tool arguments fail loudly", () => {
  const { reported, constructors } = parts();
  const projector = new ResponseProjector({ report: (part) => reported.push(part as never) }, constructors);
  projector.handle({ kind: "tool-start", id: "c3", name: "t" });
  projector.handle({ kind: "tool-args", id: "c3", value: "not json" });
  assert.throws(() => projector.handle({ kind: "finish", reason: "tool_calls" }), /invalid tool arguments/);
});
