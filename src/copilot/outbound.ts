/**
 * Projects gateway stream events into VS Code response parts: visible text,
 * reasoning (as thinking parts with an explicit close), tool calls (arguments
 * assembled per call id before being reported) and the usage record.
 */

import type * as vscode from "vscode";
import type { SseEvent } from "../gateway/sse";

export interface PartConstructors {
  readonly text: typeof vscode.LanguageModelTextPart;
  readonly thinking: typeof vscode.LanguageModelThinkingPart;
  readonly toolCall: typeof vscode.LanguageModelToolCallPart;
  readonly data: typeof vscode.LanguageModelDataPart;
}

export interface UsageReport {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
}

export class ResponseProjector {
  private thinkingOpen = false;
  private readonly toolArgs = new Map<string, string>();
  private readonly toolOrder: string[] = [];

  constructor(
    private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    private readonly parts: PartConstructors,
    private readonly onUsage?: (usage: UsageReport) => void,
    /** Restores gateway-sanitized tool names to the host's originals. */
    private readonly mapToolName: (name: string) => string = (name) => name,
  ) {}

  handle(event: SseEvent): void {
    switch (event.kind) {
      case "text":
        this.closeThinking();
        this.progress.report(new this.parts.text(event.value));
        break;
      case "reasoning":
        this.thinkingOpen = true;
        this.progress.report(new this.parts.thinking(event.value));
        break;
      case "tool-start":
        this.closeThinking();
        this.toolOrder.push(event.id);
        this.toolNames.set(event.id, event.name);
        this.toolArgs.set(event.id, "");
        break;
      case "tool-args": {
        const soFar = this.toolArgs.get(event.id);
        if (soFar !== undefined) this.toolArgs.set(event.id, soFar + event.value);
        break;
      }
      case "finish":
        this.flushTools();
        break;
      case "usage":
        this.flushTools();
        this.onUsage?.({
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          cachedTokens: event.cachedTokens,
        });
        this.progress.report(
          new this.parts.data(
            new TextEncoder().encode(
              JSON.stringify({
                prompt_tokens: event.promptTokens,
                completion_tokens: event.completionTokens,
                cached_tokens: event.cachedTokens,
              }),
            ),
            "usage",
          ),
        );
        break;
      case "protocol-error":
        throw new Error(event.message);
    }
  }

  /** Sanitized → original name per call id (for tool-name restore). */
  private readonly toolNames = new Map<string, string>();

  /** Closes any open thinking segment and flushes pending tool calls. */
  settle(): void {
    this.closeThinking();
    this.flushTools();
  }

  private closeThinking(): void {
    if (!this.thinkingOpen) return;
    this.thinkingOpen = false;
    this.progress.report(new this.parts.thinking("", "", { vscode_reasoning_done: true }));
  }

  private flushTools(): void {
    for (const id of this.toolOrder.splice(0)) {
      const name = this.toolNames.get(id);
      this.toolNames.delete(id);
      const raw = this.toolArgs.get(id) ?? "";
      this.toolArgs.delete(id);
      if (!name) continue; // never received a name: unusable call
      this.progress.report(new this.parts.toolCall(id, this.mapToolName(name), parseArguments(raw)));
    }
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("NaN returned invalid tool arguments");
  }
}
