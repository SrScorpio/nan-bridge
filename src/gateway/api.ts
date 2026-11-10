/**
 * Typed client for the NaN.Builders gateway. Owns the request slot queue and
 * the single in-flight retry, so every caller gets the same protection against
 * the per-key parallel-request limit.
 *
 * A chat slot is held from request start until the response stream settles —
 * abandoned streams release through the generator's `finally`.
 */

import { CancelledError, httpError, ProviderError } from "../errors";
import { httpFetch, type HttpResult } from "./http";
import { SseDecoder, type SseEvent } from "./sse";
import { createSlotQueue } from "./slots";

export interface ChatMessagePart {
  readonly type: "text" | "image_url";
  readonly text?: string;
  readonly imageUrl?: string;
}

export interface ChatToolSpec {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Record<string, unknown>;
}

export interface ChatRequestBody {
  readonly model: string;
  readonly stream_options?: { readonly include_usage: boolean };
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly content: string | readonly ChatMessagePart[];
    readonly tool_calls?: ReadonlyArray<{
      readonly id: string;
      readonly function: { readonly name: string; readonly arguments: string };
    }>;
    readonly tool_call_id?: string;
  }>;
  readonly stream: true;
  readonly tools?: ReadonlyArray<{ type: "function"; function: ChatToolSpec }>;
  readonly tool_choice?: string;
  readonly reasoning_effort?: string;
}

export interface UsageSummary {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
}

export interface NaNApiDeps {
  /** Reads the current key; may be absent (auth errors surface as such). */
  readonly key: () => Promise<string | undefined>;
  readonly baseUrl: () => string;
  readonly userAgent: () => string;
  readonly connectTimeoutMs: () => number;
  readonly idleTimeoutMs: () => number;
  readonly fetcher?: typeof fetch;
}

const MAX_PARALLEL_PER_KEY = 7;
/** Self-imposed cap per API client instance. */
const BRIDGE_SLOT_LIMIT = 2;
/** Only wait out a 429 when the gateway asks for a short pause. */
const MAX_HONORED_RETRY_MS = 15_000;
const SERVER_ERROR_BACKOFF_MS = 2_000;

export class NaNApi {
  private readonly slots = createSlotQueue(BRIDGE_SLOT_LIMIT);

  constructor(private readonly deps: NaNApiDeps) {}

  /** GET /models — the live catalog ids. */
  async listModels(signal?: AbortSignal): Promise<unknown> {
    return this.withSlot(async () => {
      const result = await this.send("/models", "GET", undefined, signal);
      const text = await result.text();
      if (result.status >= 400) throw httpError(result.status, text, retryAfterMs(result.headers));
      return JSON.parse(text) as unknown;
    });
  }

  /**
   * GET /usage — plan totals for the current key. The report is paginated
   * (ascending by date, 100 rows per page); while today's rows spill over
   * into the next page we follow the cursor (bounded) so "this month"
   * aggregates stay complete.
   */
  async fetchUsage(signal?: AbortSignal): Promise<unknown> {
    return this.withSlot(async () => {
      const first = asUsageReport(await this.usagePage(undefined, signal));
      if (!first) return undefined;
      const pages: UsageReportPayload[] = [first];
      let cursor = typeof first.next_cursor === "string" ? first.next_cursor : "";
      let lastRowDate = lastRowDateOf(first);
      while (cursor && lastRowDate === first.end_date && pages.length < 5) {
        const page = asUsageReport(await this.usagePage(cursor, signal));
        if (!page) break;
        pages.push(page);
        lastRowDate = lastRowDateOf(page);
        cursor = typeof page.next_cursor === "string" ? page.next_cursor : "";
      }
      if (pages.length === 1) return first;
      const seen = new Set<string>();
      const data = pages
        .flatMap((page) => page.data)
        .filter((row): row is NonNullable<typeof row> => row !== null && row !== undefined)
        .filter((row) => {
          const key = `${row.date}|${row.model}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return { ...first, data };
    });
  }

  private async usagePage(cursor: string | undefined, signal?: AbortSignal): Promise<unknown> {
    const path = cursor ? `/usage?cursor=${encodeURIComponent(cursor)}` : "/usage";
    const result = await this.send(path, "GET", undefined, signal);
    const text = await result.text();
    if (result.status >= 400) throw httpError(result.status, text, retryAfterMs(result.headers));
    return JSON.parse(text) as unknown;
  }

  /**
   * POST /chat/completions. Resolves once the gateway accepts the request;
   * iterate `events` for decoded stream events. The slot is released when the
   * stream ends, errors or is abandoned.
   */
  async openChat(body: ChatRequestBody, signal?: AbortSignal): Promise<AsyncGenerator<SseEvent>> {
    await this.slots.acquire();
    let attempt = 0;
    for (;;) {
      let result: HttpResult;
      try {
        result = await this.send("/chat/completions", "POST", JSON.stringify(body), signal);
      } catch (error) {
        this.slots.release();
        throw error;
      }
      if (result.status < 400) {
        return this.streamEvents(result);
      }
      const errorBody = await result.text();
      const error = httpError(result.status, errorBody, retryAfterMs(result.headers));
      const pause = retryPause(error);
      const canRetry = attempt === 0 && pause !== undefined && !signal?.aborted;
      if (!canRetry) {
        this.slots.release();
        throw error;
      }
      attempt += 1;
      await delay(pause);
      if (signal?.aborted) {
        this.slots.release();
        throw new CancelledError();
      }
    }
  }

  private async *streamEvents(result: HttpResult): AsyncGenerator<SseEvent> {
    const decoder = new SseDecoder();
    try {
      for await (const chunk of result.chunks()) {
        for (const event of decoder.push(chunk)) yield event;
      }
      for (const event of decoder.close()) yield event;
    } finally {
      result.dispose();
      this.slots.release();
    }
  }

  private async send(
    path: string,
    method: "GET" | "POST",
    body: string | undefined,
    signal?: AbortSignal,
  ): Promise<HttpResult> {
    const key = await this.deps.key();
    if (!key) {
      throw new ProviderError(
        "invalid_api_key",
        'No API key stored for this profile. Run "NaN Bridge: Set API Key".',
      );
    }
    return httpFetch({
      url: `${this.deps.baseUrl()}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: method === "POST" ? "text/event-stream" : "application/json",
        "User-Agent": this.deps.userAgent(),
      },
      body,
      connectTimeoutMs: this.deps.connectTimeoutMs(),
      idleTimeoutMs: this.deps.idleTimeoutMs(),
      signal,
      fetcher: this.deps.fetcher,
    });
  }

  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    await this.slots.acquire();
    try {
      return await work();
    } finally {
      this.slots.release();
    }
  }
}


function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function retryPause(error: ProviderError): number | undefined {
  if (error.code === "rate_limit_exceeded") {
    const hint = error.retryAfterMs ?? SERVER_ERROR_BACKOFF_MS;
    return hint <= MAX_HONORED_RETRY_MS ? hint : undefined;
  }
  if (error.status !== undefined && [502, 503, 504].includes(error.status)) {
    return SERVER_ERROR_BACKOFF_MS;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface UsageReportPayload {
  start_date?: unknown;
  end_date?: unknown;
  next_cursor?: unknown;
  data?: Array<{ date?: unknown; model?: unknown } | null>;
}

function asUsageReport(payload: unknown): UsageReportPayload | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const report = payload as UsageReportPayload;
  return Array.isArray(report.data) ? report : undefined;
}

/** Date of the report's last usable row (rows ascend by date). */
function lastRowDateOf(report: UsageReportPayload): string {
  const rows = report.data ?? [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const date = rows[i]?.date;
    if (typeof date === "string") return date;
  }
  return "";
}
