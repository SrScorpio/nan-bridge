import test from "node:test";
import assert from "node:assert/strict";
import { roughTokens, trimToFit } from "./history.js";
import type { OutgoingMessage } from "./inbound.js";

function user(text: string): OutgoingMessage {
  return { role: "user", content: text };
}

test("estimates tokens from text length", () => {
  assert.ok(roughTokens([user("x".repeat(400))]) > 100);
});

test("keeps the first and last turns when trimming the middle", () => {
  const messages: OutgoingMessage[] = [
    user("system framing"),
    ...Array.from({ length: 20 }, (_, index) => user(`turn ${index} ${"x".repeat(400)}`)),
    user("final question"),
  ];
  const trimmed = trimToFit(messages, 1200);
  assert.equal(trimmed[0].content, "system framing");
  assert.equal(trimmed[trimmed.length - 1].content, "final question");
  assert.ok(trimmed.length < messages.length);
});

test("never returns an empty conversation", () => {
  const messages = [user("only turn")];
  assert.equal(trimToFit(messages, 1).length, 1);
});

function assistantToolRound(index: number): OutgoingMessage[] {
  const callId = `call-${index}`;
  return [
    {
      role: "assistant",
      content: [],
      tool_calls: [{ id: callId, function: { name: "read_file", arguments: "{}" } }],
    },
    { role: "tool", content: `result ${index}`, tool_call_id: callId },
  ];
}

test("trimming never orphans a tool result from its assistant call", () => {
  const messages: OutgoingMessage[] = [
    user("framing"),
    ...Array.from({ length: 12 }, (_, index) => [
      user(`turn ${index} ${"x".repeat(400)}`),
      ...assistantToolRound(index),
    ]).flat(),
    user("final question"),
  ];
  const trimmed = trimToFit(messages, 1500);
  // Every kept tool result must belong to a kept assistant message.
  const keptCallIds = new Set(
    trimmed.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
  );
  for (const message of trimmed) {
    if (message.role === "tool" && message.tool_call_id) {
      assert.ok(keptCallIds.has(message.tool_call_id), `orphan tool result ${message.tool_call_id}`);
    }
  }
});
