import test from "node:test";
import assert from "node:assert/strict";
import { convertMessages } from "./inbound.js";

const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;

test("joins plain text parts into string content", () => {
  const [first] = convertMessages([{ role: ROLE_USER, content: [{ value: "hello " }, { value: "world" }] }]);
  assert.equal(first.role, "user");
  assert.equal(first.content, "hello world");
});

test("emits assistant tool calls with stringified input", () => {
  const [message] = convertMessages([
    {
      role: ROLE_ASSISTANT,
      content: [{ callId: "t1", name: "list_dir", input: { path: "." } }],
    },
  ]);
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.tool_calls, [
    { id: "t1", function: { name: "list_dir", arguments: '{"path":"."}' } },
  ]);
});

test("emits tool results as tool messages carrying the call id", () => {
  const [tool] = convertMessages([
    {
      role: ROLE_USER,
      content: [{ callId: "t1", content: [{ value: "file.txt" }] }],
    },
  ]);
  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "t1");
  assert.equal(tool.content, "file.txt");
});

test("encodes image parts as data URLs", () => {
  const [message] = convertMessages([
    {
      role: ROLE_USER,
      content: [{ value: "what is this?" }, { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }],
    },
  ]);
  assert.ok(Array.isArray(message.content));
  const parts = message.content as Array<{ type: string; imageUrl?: string; text?: string }>;
  assert.equal(parts[1].type, "image_url");
  assert.match(parts[1].imageUrl ?? "", /^data:image\/png;base64,/);
});
