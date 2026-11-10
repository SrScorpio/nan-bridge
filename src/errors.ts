/**
 * Error types and friendly mapping for everything the gateway can throw.
 *
 * Rules:
 * - A mapped code gets a message that tells the user what to DO.
 * - An unmapped code shows the gateway's own message, verbatim but bounded —
 *   remote validation text is usually more useful than anything we invent.
 */

export type ProviderErrorCode =
  | "invalid_api_key"
  | "insufficient_quota"
  | "rate_limit_exceeded"
  | "model_not_found"
  | "context_length_exceeded"
  | "timeout"
  | "network"
  | "cancelled"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Request cancelled");
    this.name = "CancelledError";
  }
}

const FRIENDLY: Partial<Record<ProviderErrorCode, string>> = {
  invalid_api_key:
    'NaN rejected the API key. Run "NaN Bridge: Set API Key" and paste a key from cloud.nan.builders.',
  insufficient_quota:
    "The NaN plan behind this key is out of quota. Check the plan on cloud.nan.builders.",
  rate_limit_exceeded:
    "NaN reached the parallel-request limit for this key (max 7). The bridge queues requests, but other clients on the same key still count. Use a dedicated key for VS Code and retry shortly.",
  model_not_found:
    'NaN does not serve this model for your key. Run "NaN Bridge: Refresh Models" and pick one from the current catalog.',
  context_length_exceeded:
    "Conversation exceeds the model's context window. Start a shorter chat or clear old turns.",
  timeout: "NaN did not answer in time. The connection may be stalled; retry.",
  network: "Could not reach api.nan.builders. Check the network or the API base URL setting.",
};

/** Pulls a human message out of any thrown value, unwrapping nested `{error:{message}}`. */
export function explain(error: unknown): string {
  if (error instanceof ProviderError) {
    const friendly = FRIENDLY[error.code];
    return friendly ? `${friendly} (NaN said: ${error.message})` : error.message;
  }
  const nested = messageFromPayload(error);
  if (nested) return nested;
  if (error instanceof Error) return error.message;
  return String(error);
}

function messageFromPayload(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const carrier = error as { error?: { message?: unknown }; message?: unknown };
  const candidate = carrier.error?.message ?? carrier.message;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

interface GatewayErrorBody {
  error?: { code?: string; message?: string };
  message?: string;
}

/** Converts a failed HTTP response into a ProviderError. */
export function httpError(status: number, body: string, retryAfterMs?: number): ProviderError {
  let payload: GatewayErrorBody = {};
  try {
    payload = JSON.parse(body) as GatewayErrorBody;
  } catch {
    /* non-JSON error body */
  }
  const code = payload.error?.code ?? "";
  const raw =
    payload.error?.message ??
    payload.message ??
    (body.trim() ? body.trim() : `HTTP ${status} with no error body`);
  const bounded = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  const mapped = code as ProviderErrorCode;
  if (code in FRIENDLY) {
    return new ProviderError(mapped, bounded, status, retryAfterMs);
  }
  if (status === 429) return new ProviderError("rate_limit_exceeded", bounded, status, retryAfterMs);
  if (status === 401 || status === 403) return new ProviderError("invalid_api_key", bounded, status);
  if (status === 404 && /model/i.test(raw)) return new ProviderError("model_not_found", bounded, status);
  return new ProviderError("unknown", `NaN request failed (${status}): ${bounded}`, status, retryAfterMs);
}

/** Network-level failures: DNS, refused connections, aborted fetches. */
export function transportError(error: unknown): ProviderError {
  const name = (error as { name?: string })?.name ?? "";
  if (name === "AbortError" || name === "CancelledError") return new ProviderError("cancelled", "Request cancelled");
  if (name === "TimeoutError") {
    // The abort reason names the clock that fired ("connect timeout" / "stream idle timeout").
    const reason = (error as Error).message;
    return new ProviderError("timeout", reason || "Request timed out");
  }
  return new ProviderError("network", explain(error));
}
