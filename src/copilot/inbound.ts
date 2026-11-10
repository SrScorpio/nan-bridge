/**
 * Converts VS Code chat request messages into the gateway's message format.
 * Parts are matched structurally (duck-typing) because the provider API
 * delivers text, tool calls, tool results and image data as plain part
 * objects whose runtime classes vary between VS Code builds — and so this
 * module stays testable outside the editor host.
 */

import type { ChatMessagePart } from "../gateway/api";
import { sanitizeToolName } from "./tool-names";

/** Structural view of `vscode.LanguageModelChatRequestMessage`. */
export interface InboundMessage {
  /** `LanguageModelChatMessageRole`: User = 1, Assistant = 2. */
  readonly role: number;
  readonly content: readonly unknown[];
}

export interface OutgoingMessage {
  readonly role: string;
  readonly content: string | readonly ChatMessagePart[];
  readonly tool_calls?: ReadonlyArray<{
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly tool_call_id?: string;
}

const ROLE_ASSISTANT = 2;

interface ToolCallShape { callId: string; name: string; input?: unknown }
interface ToolResultShape { callId: string; content: readonly unknown[] }
interface ImageShape { data: Uint8Array; mimeType: string }
interface TextShape { value: string }

function asToolCall(part: unknown): ToolCallShape | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const candidate = part as Partial<ToolCallShape>;
  return typeof candidate.callId === "string" && typeof candidate.name === "string" && !("content" in candidate)
    ? (part as ToolCallShape)
    : undefined;
}

function asToolResult(part: unknown): ToolResultShape | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const candidate = part as Partial<ToolResultShape>;
  return typeof candidate.callId === "string" && Array.isArray(candidate.content)
    ? (part as ToolResultShape)
    : undefined;
}

function asImage(part: unknown): ImageShape | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const candidate = part as Partial<ImageShape>;
  return candidate.data instanceof Uint8Array && typeof candidate.mimeType === "string"
    ? (part as ImageShape)
    : undefined;
}

function asText(part: unknown): TextShape | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const candidate = part as Partial<TextShape>;
  return typeof candidate.value === "string" ? (part as TextShape) : undefined;
}

export function convertMessages(messages: readonly InboundMessage[]): readonly OutgoingMessage[] {
  const outgoing: OutgoingMessage[] = [];
  for (const message of messages) {
    const assistant = message.role === ROLE_ASSISTANT;
    let plain = true;
    const parts: ChatMessagePart[] = [];
    const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];

    for (const part of message.content) {
      const toolResult = asToolResult(part);
      if (toolResult) {
        // Tool results travel as their own `tool` messages right after the
        // assistant turn that requested them.
        outgoing.push({
          role: "tool",
          content: renderContent(toolResult.content),
          tool_call_id: toolResult.callId,
        });
        continue;
      }
      const toolCall = asToolCall(part);
      if (toolCall) {
        toolCalls.push({
          id: toolCall.callId,
          function: {
            // Same gateway-safe form as the tools declaration, so replayed
            // history never trips the name validation.
            name: sanitizeToolName(toolCall.name),
            arguments: JSON.stringify(toolCall.input ?? {}),
          },
        });
        continue;
      }
      const image = asImage(part);
      if (image) {
        plain = false;
        parts.push({
          type: "image_url",
          imageUrl: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
        });
        continue;
      }
      const text = asText(part);
      if (text) parts.push({ type: "text", text: text.value });
    }

    if (!parts.length && !toolCalls.length) continue;
    outgoing.push(
      plain && parts.length
        ? { role: assistant ? "assistant" : "user", content: parts.map((piece) => piece.text ?? "").join("") }
        : {
            role: assistant ? "assistant" : "user",
            content: parts,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
    );
  }
  return outgoing;
}

function renderContent(content: readonly unknown[]): string {
  const fragments: string[] = [];
  for (const value of content) {
    const text = asText(value);
    if (text) fragments.push(text.value);
    else if (asImage(value)) fragments.push("[image result]");
    else if (typeof value === "string") fragments.push(value);
  }
  return fragments.join("\n");
}
