/**
 * Assembles the chat request body from a VS Code turn: history conversion,
 * context trimming, tool specs and the per-model effort. Pure module — no
 * runtime `vscode` import, so it stays testable under `node --test`.
 */

import type { ChatRequestBody, ChatToolSpec } from "../gateway/api";
import type { CatalogEntry } from "../models/catalog";
import { effortForModel, isEffortLevel } from "../models/efforts";
import { resolveContextCap } from "../models/context";
import { convertMessages, type OutgoingMessage } from "./inbound";
import type { InboundMessage } from "./inbound";
import { sanitizeToolName } from "./tool-names";
import { trimToFit } from "./history";

/** `vscode.LanguageModelChatToolMode.Required` — kept numeric to stay pure. */
const TOOL_MODE_REQUIRED = 2;

/** Structural copy of `vscode.LanguageModelChatTool` for pure modules. */
export interface ChatToolInput {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface RequestOptions {
  readonly model: CatalogEntry;
  readonly effort?: string;
  /** Chosen context tier (number) or "auto" from the model configuration UI. */
  readonly contextSize?: number;
  readonly tools?: readonly ChatToolInput[];
  /** `vscode.LanguageModelChatToolMode` numeric value. */
  readonly toolMode?: number;
}

const SYSTEM_FRAMING =
  "You are an AI assistant inside VS Code, serving Copilot Chat through NaN.Builders. " +
  "Follow the user's tool-call requests precisely and keep answers compact.";

export function buildRequestBody(
  messages: readonly InboundMessage[],
  options: RequestOptions,
): ChatRequestBody {
  const history = convertMessages(messages);
  // The cap bounds the INPUT budget (output already carved out of the
  // catalog entry); "auto" or a full-size choice leaves the limit untouched.
  const cap = resolveContextCap(options.contextSize ?? Number.NaN, options.model.inputTokens);
  const budget = cap ?? options.model.inputTokens;
  let trimmed = trimToFit([framingMessage(), ...history], budget);
  if (!trimmed.some((message) => message.role !== "system")) {
    // The gateway rejects empty message lists; keep a minimal user turn.
    trimmed = [...trimmed, { role: "user", content: [{ type: "text", text: "" }] }];
  }
  const effort = resolvedEffort(options);
  const tools = options.tools?.length ? convertTools(options.tools) : undefined;
  return {
    model: options.model.id,
    messages: trimmed,
    stream: true,
    // Ask the gateway to report token usage on the final chunk, so every
    // request updates the usage panel without an extra round trip.
    stream_options: { include_usage: true },
    ...(tools ? { tools, tool_choice: toolChoice(options.toolMode) } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

function framingMessage(): OutgoingMessage {
  return { role: "system", content: SYSTEM_FRAMING };
}

function resolvedEffort(options: RequestOptions): string | undefined {
  if (!options.effort || !isEffortLevel(options.effort)) return undefined;
  return effortForModel(options.model.id, options.effort);
}

function convertTools(tools: readonly ChatToolInput[]): Array<{ type: "function"; function: ChatToolSpec }> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      // The gateway rejects names outside [a-zA-Z0-9_-]; the provider maps
      // them back to the originals when tool calls return.
      name: sanitizeToolName(tool.name),
      ...(tool.description ? { description: tool.description } : {}),
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
}

function toolChoice(mode: number | undefined): string {
  return mode === TOOL_MODE_REQUIRED ? "required" : "auto";
}
