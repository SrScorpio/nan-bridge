import test from "node:test";
import assert from "node:assert/strict";
import { buildRequestBody } from "./request.js";
import { mergeCatalog } from "../models/catalog.js";

const MODEL = mergeCatalog({ data: [{ id: "glm5.3" }] })[0];

test("never ships an empty message list", () => {
  const body = buildRequestBody([], { model: MODEL });
  assert.ok(body.messages.length >= 2);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[body.messages.length - 1].role, "user");
});

test("applies remapped reasoning effort", () => {
  const body = buildRequestBody([], { model: MODEL, effort: "none" });
  assert.equal(body.reasoning_effort, "minimal");
});

test("forwards tools in function format with conditional description", () => {
  const body = buildRequestBody(
    [],
    {
      model: MODEL,
      tools: [
        { name: "list_dir", inputSchema: { type: "object", properties: {} } },
        { name: "read_file", description: "Reads a file", inputSchema: { type: "object", properties: {} } },
      ],
    },
  );
  assert.equal(body.tools?.length, 2);
  assert.ok(!("description" in body.tools[0].function));
  assert.equal(body.tools[1].function.description, "Reads a file");
});

test("stream requests ask the gateway to include usage", () => {
  const body = buildRequestBody([{ role: 1, content: [{ value: "hi" }] }], { model: mergeCatalog({ data: [{ id: "glm5.3-flash" }] })[0] });
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.stream, true);
});

test("a context tier bounds the input budget without going negative", () => {
  // glm5.3: 1M window, 262K output. A 64K tier must cap input at 64K, not
  // subtract the output reservation from the tier (which used to go negative
  // and gut the conversation).
  const body = buildRequestBody(
    [
      { role: 1, content: [{ value: "turn one".padEnd(8000, "x") }] },
      { role: 1, content: [{ value: "turn two".padEnd(8000, "x") }] },
      { role: 1, content: [{ value: "final question" }] },
    ],
    { model: MODEL, contextSize: 65_536 },
  );
  const roles = body.messages.map((message) => message.role);
  assert.equal(roles[0], "system");
  // Enough budget survives that interior turns are not all dropped.
  assert.ok(roles.length >= 3, `expected interior turns kept, got ${roles.length}`);
});
