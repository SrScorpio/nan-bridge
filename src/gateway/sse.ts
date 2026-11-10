/**
 * Decoder for the NaN gateway's `text/event-stream` chat responses.
 *
 * The gateway emits `data: {json}` blocks separated by blank lines and closes
 * with `data: [DONE]`. Assistant deltas arrive over time: visible text,
 * reasoning text, tool-call fragments and a final usage record. This decoder
 * turns that byte stream into a flat sequence of typed events so the Copilot
 * layer never has to touch raw SSE.
 */

export type SseEvent =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "reasoning"; readonly value: string }
  | { readonly kind: "tool-start"; readonly id: string; readonly name: string }
  | { readonly kind: "tool-args"; readonly id: string; readonly value: string }
  | { readonly kind: "finish"; readonly reason: string }
  | {
      readonly kind: "usage";
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly cachedTokens: number;
    }
  | { readonly kind: "protocol-error"; readonly message: string };

interface ToolCallDelta {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Incremental decoder. Feed `push()` every decoded chunk as it arrives and
 * `close()` when the stream ends; both return the events they produced.
 *
 * Tool fragments are matched to their call by identity: a fragment carrying an
 * `id` opens a new call, fragments without one continue the most recent open
 * call. That is how the gateway streams argument tails.
 */
export class SseDecoder {
  private buffer = "";
  private openToolId: string | undefined;
  private done = false;

  push(chunk: string): readonly SseEvent[] {
    return this.consume((this.buffer += chunk));
  }

  /** Flushes whatever is left; an unterminated stream reports itself. */
  close(): readonly SseEvent[] {
    const events = [...this.consume(this.buffer, true)];
    if (!this.done) {
      events.push({
        kind: "protocol-error",
        message: "NaN stream ended without a [DONE] sentinel",
      });
    }
    return events;
  }

  private consume(source: string, flush = false): readonly SseEvent[] {
    const events: SseEvent[] = [];
    let boundary = source.indexOf("\n\n");
    let scanned = 0;
    while (boundary >= 0) {
      const block = source.slice(scanned, boundary);
      scanned = boundary + 2;
      this.decodeBlock(block, events);
      boundary = source.indexOf("\n\n", scanned);
    }
    this.buffer = source.slice(scanned);
    if (flush && this.buffer.trim()) this.decodeBlock(this.buffer, events);
    return events;
  }

  private decodeBlock(block: string, events: SseEvent[]): void {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      // Spec: a data payload split across lines rejoins with \n (JSON payloads
      // carry no raw newlines inside strings, so this is lossless).
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      this.done = true;
      return;
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(data) as ChatChunk;
    } catch {
      events.push({ kind: "protocol-error", message: `Unparseable stream block: ${data.slice(0, 120)}` });
      return;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) events.push({ kind: "text", value: delta.content });
    if (delta?.reasoning_content) events.push({ kind: "reasoning", value: delta.reasoning_content });
    for (const fragment of delta?.tool_calls ?? []) {
      const id = fragment.id;
      if (id) {
        this.openToolId = id;
        events.push({ kind: "tool-start", id, name: fragment.function?.name ?? "" });
      }
      const args = fragment.function?.arguments;
      if (args && this.openToolId) {
        events.push({ kind: "tool-args", id: this.openToolId, value: args });
      }
    }
    if (choice?.finish_reason) events.push({ kind: "finish", reason: choice.finish_reason });
    const usage = chunk.usage;
    if (usage) {
      events.push({
        kind: "usage",
        promptTokens: asCount(usage.prompt_tokens),
        completionTokens: asCount(usage.completion_tokens),
        cachedTokens: asCount(usage.prompt_tokens_details?.cached_tokens),
      });
    }
  }
}

/** A gateway regression sending strings/null/NaN in counters must not poison
 *  the tracker with NaN sums — non-finite values count as zero. */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
