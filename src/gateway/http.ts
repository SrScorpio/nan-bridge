/**
 * HTTP core for the NaN gateway with two independent clocks:
 *
 * - connect timeout: request sent → response headers received.
 * - idle timeout: re-armed on every body chunk, cleared when the body ends.
 *
 * A total deadline (what the bridge used before 1.0) killed healthy long agent
 * turns; these two clocks only fire when the gateway is actually unresponsive.
 */

import { transportError } from "../errors";

export interface HttpOptions {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: () => Promise<string>;
  /** Streams the body as decoded text chunks; aborts on idle timeout. */
  readonly chunks: () => AsyncGenerator<string>;
  /** Clears all timers. Safe to call more than once. */
  readonly dispose: () => void;
}

export async function httpFetch(options: HttpOptions): Promise<HttpResult> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopTimers = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const bail = (reason: string) => {
    controller.abort(new Error(reason));
  };
  /** Named TimeoutError so transportError reports "timed out", not "cancelled". */
  const bailTimeout = (reason: string) => {
    controller.abort(new DOMException(reason, "TimeoutError"));
  };

  // External cancellation (VS Code token) always wins.
  options.signal?.addEventListener("abort", () => bail("cancelled"), { once: true });

  const connectTimer = setTimeout(() => bailTimeout("connect timeout"), options.connectTimeoutMs);

  let response: Response;
  try {
    response = await fetcher(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
  } catch (error) {
    stopTimers();
    clearTimeout(connectTimer);
    throw transportError(error);
  }
  clearTimeout(connectTimer);
  if (!response.ok || !response.body) {
    settled = true;
    stopTimers();
    return {
      status: response.status,
      headers: response.headers,
      text: () => response.text(),
      chunks: async function* () { /* error responses are read via text() */ },
      dispose: () => undefined,
    };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();
  let decoded = "";
  const takeReader = () => (reader ??= response.body!.getReader());
  const armIdle = () => {
    if (settled) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => bailTimeout("stream idle timeout"), options.idleTimeoutMs);
  };
  armIdle();

  const dispose = () => {
    settled = true;
    stopTimers();
  };

  async function* streamChunks(): AsyncGenerator<string> {
    try {
      for (;;) {
        const { done, value } = await takeReader().read();
        if (done) break;
        armIdle();
        const piece = decoder.decode(value, { stream: true });
        decoded += piece;
        yield piece;
      }
    } catch (error) {
      throw transportError(error);
    } finally {
      dispose();
      void reader?.cancel().catch(() => undefined);
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    async text() {
      try {
        if (!reader) return await response.text();
        // Already streaming: finish the stream and return everything seen.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          decoded += decoder.decode(value, { stream: true });
        }
        return decoded + decoder.decode();
      } finally {
        dispose();
      }
    },
    chunks: streamChunks,
    dispose,
  };
}
