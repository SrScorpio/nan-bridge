/**
 * Usage tracking: local per-model token/request counters (survives restarts
 * via the host state) merged with the gateway's own remote totals. Numbers
 * shown to the user are always deterministic (`en-US` grouping).
 */

import type { UsageReport } from "../copilot/outbound";
import { DEFAULT_PROFILE } from "../secrets/keys";

export interface ModelUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface UsageSnapshot {
  readonly models: Readonly<Record<string, ModelUsage>>;
  readonly totalRequests: number;
  readonly totalTokens: number;
  readonly remote?: RemoteUsage;
  readonly updatedAt?: number;
}

type Persisted = Record<string, Record<string, ModelUsage>>;

export interface UsageStateStore {
  read(): Promise<Persisted>;
  write(value: Persisted): Promise<void>;
}

/** In-memory store for tests and default profile-less operation. */
export class MemoryUsageStore implements UsageStateStore {
  private value: Persisted = {};
  async read(): Promise<Persisted> {
    return this.value;
  }
  async write(value: Persisted): Promise<void> {
    this.value = value;
  }
}

export interface RemoteModelUsage {
  readonly model: string;
  readonly requests: number;
  readonly totalTokens: number;
  /** Credits billed for this model in the window (only rows billed in
   *  credits count — the gateway started billing this way on 2026-11-10). */
  readonly credits?: number;
}

/** Current billing period, straight from the report's `credits` object. It
 *  covers the period, not the requested window, and may lag the live
 *  balance by up to a minute. */
export interface RemoteCredits {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly allowance: number;
  readonly used: number;
  readonly remaining: number;
  readonly packCredits: number;
  readonly packExpiresAt?: string;
  /** `true` while the subscription is inactive: credit-billed requests are
   *  refused until it is restored. */
  readonly frozen: boolean;
}

export interface RemoteUsage {
  readonly startDate: string;
  readonly endDate: string;
  readonly requests: number;
  readonly totalTokens: number;
  readonly byModel: readonly RemoteModelUsage[];
  /** Credits billed in the requested window (`totals.credits` when the
   *  report carries totals, else summed from the rows). */
  readonly credits?: number;
  /** Current billing period balance. */
  readonly period?: RemoteCredits;
  /** Calendar-month slice of the window (from the rows dated in the month
   *  of `endDate`), so the panel can show spend-to-date and quotas. */
  readonly month?: RemoteMonthUsage;
}

export interface RemoteMonthUsage {
  /** e.g. "November 2026" (en-US, derived from the report's end date). */
  readonly label: string;
  readonly requests: number;
  readonly totalTokens: number;
  readonly credits?: number;
  readonly byModel: readonly RemoteModelUsage[];
}

/**
 * Parses the gateway's `/usage` report (`usage.report` object: daily rows
 * per model, window `totals`, current-period `credits`) into a per-model
 * aggregate. Returns undefined when the payload carries no usable data.
 *
 * `totals` is preferred for the window figures: the spec guarantees it
 * covers the whole requested window even when the rows came back
 * paginated, so summing pages can never undercount. Rows are still what
 * feeds the calendar-month slice and the per-day/per-model credits.
 */
export function parseRemoteUsage(payload: unknown): RemoteUsage | undefined {
  const report = payload as
    | {
        start_date?: unknown;
        end_date?: unknown;
        data?: Array<{ date?: unknown; model?: unknown; api_requests?: unknown; total_tokens?: unknown; credits?: unknown } | null>;
        totals?: unknown;
        credits?: unknown;
      }
    | null;
  const rows = Array.isArray(report?.data) ? report.data : [];
  const totals = parseTotals(report?.totals);
  if (!rows.length && !totals) return undefined;

  const byModel = new Map<string, RemoteModelUsage>();
  let requests = 0;
  let totalTokens = 0;
  let credits = 0;
  let creditsSeen = false;
  // The calendar-month slice: rows dated in the month of the report's end
  // date (the gateway's clock, immune to the local machine's timezone).
  const endDate = typeof report?.end_date === "string" ? report.end_date : "";
  const monthPrefix = endDate.slice(0, 7);
  const monthByModel = new Map<string, RemoteModelUsage>();
  let monthRequests = 0;
  let monthTokens = 0;
  let monthCredits = 0;
  let monthCreditsSeen = false;
  let monthRows = 0;

  for (const row of rows) {
    const model = typeof row?.model === "string" ? row.model : "";
    if (!model) continue;
    const rowRequests = finite(row?.api_requests) ?? 0;
    const rowTokens = finite(row?.total_tokens) ?? 0;
    const rowCredits = finite(row?.credits);
    const inMonth = typeof row?.date === "string" && row.date.startsWith(monthPrefix);

    const current = byModel.get(model) ?? { model, requests: 0, totalTokens: 0, credits: 0 };
    byModel.set(model, {
      model,
      requests: current.requests + rowRequests,
      totalTokens: current.totalTokens + rowTokens,
      credits: sumCredits(current.credits, rowCredits),
    });
    requests += rowRequests;
    totalTokens += rowTokens;
    if (rowCredits !== undefined) {
      credits = sumCredits(credits, rowCredits);
      creditsSeen = true;
    }

    if (inMonth) {
      const monthCurrent = monthByModel.get(model) ?? { model, requests: 0, totalTokens: 0, credits: 0 };
      monthByModel.set(model, {
        model,
        requests: monthCurrent.requests + rowRequests,
        totalTokens: monthCurrent.totalTokens + rowTokens,
        credits: sumCredits(monthCurrent.credits, rowCredits),
      });
      monthRequests += rowRequests;
      monthTokens += rowTokens;
      if (rowCredits !== undefined) {
        monthCredits = sumCredits(monthCredits, rowCredits);
        monthCreditsSeen = true;
      }
      monthRows += 1;
    }
  }

  // Window figures: authoritative `totals` first, row sums as the fallback.
  let windowByModel = [...byModel.values()].sort((a, b) => b.requests - a.requests);
  if (totals) {
    requests = totals.requests ?? requests;
    totalTokens = totals.totalTokens ?? totalTokens;
    if (totals.credits !== undefined) {
      credits = totals.credits;
      creditsSeen = true;
    }
    if (totals.byModel?.length) {
      windowByModel = totals.byModel.map((row) => ({
        model: row.model,
        requests: row.requests,
        totalTokens: row.totalTokens,
        credits: row.credits ?? 0,
      }));
      if (totals.credits === undefined && totals.byModel.some((row) => row.credits !== undefined)) {
        credits = totals.byModel.reduce((sum, row) => sumCredits(sum, row.credits), 0);
        creditsSeen = true;
      }
    }
  }
  if (!windowByModel.length) return undefined;

  return {
    startDate: typeof report?.start_date === "string" ? report.start_date : "",
    endDate,
    requests,
    totalTokens,
    byModel: windowByModel,
    credits: creditsSeen ? credits : undefined,
    period: parseCredits(report?.credits),
    month: monthRows
      ? {
          label: monthLabel(endDate),
          requests: monthRequests,
          totalTokens: monthTokens,
          credits: monthCreditsSeen ? monthCredits : undefined,
          byModel: [...monthByModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
        }
      : undefined,
  };
}

interface ParsedTotals {
  readonly requests?: number;
  readonly totalTokens?: number;
  readonly credits?: number;
  readonly byModel?: ReadonlyArray<{ model: string; requests: number; totalTokens: number; credits?: number }>;
}

/** `totals` of a usage report; undefined when it carries nothing usable. */
function parseTotals(value: unknown): ParsedTotals | undefined {
  const totals = value as
    | {
        api_requests?: unknown;
        total_tokens?: unknown;
        credits?: unknown;
        by_model?: Array<{ model?: unknown; api_requests?: unknown; total_tokens?: unknown; credits?: unknown } | null>;
      }
    | null
    | undefined;
  if (!totals || typeof totals !== "object") return undefined;
  const byModel = Array.isArray(totals.by_model)
    ? totals.by_model
        .map((row) => {
          const model = typeof row?.model === "string" ? row.model : "";
          if (!model) return undefined;
          return {
            model,
            requests: finite(row?.api_requests) ?? 0,
            totalTokens: finite(row?.total_tokens) ?? 0,
            credits: finite(row?.credits),
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
    : undefined;
  const parsed: ParsedTotals = {
    requests: finite(totals.api_requests),
    totalTokens: finite(totals.total_tokens),
    credits: finite(totals.credits),
    byModel: byModel?.length ? byModel : undefined,
  };
  if (parsed.requests === undefined && parsed.totalTokens === undefined && parsed.credits === undefined && !parsed.byModel) {
    return undefined;
  }
  return parsed;
}

/** The report's current billing-period `credits` block, or undefined when
 *  the account is not billed in credits (the gateway sends `null`). */
export function parseCredits(value: unknown): RemoteCredits | undefined {
  const credits = value as
    | {
        period_start?: unknown;
        period_end?: unknown;
        allowance?: unknown;
        used?: unknown;
        remaining?: unknown;
        pack_credits?: unknown;
        pack_expires_at?: unknown;
        frozen?: unknown;
      }
    | null
    | undefined;
  if (!credits || typeof credits !== "object") return undefined;
  const allowance = finite(credits.allowance);
  const used = finite(credits.used);
  const remaining = finite(credits.remaining);
  if (allowance === undefined || used === undefined || remaining === undefined) return undefined;
  return {
    periodStart: typeof credits.period_start === "string" ? credits.period_start : "",
    periodEnd: typeof credits.period_end === "string" ? credits.period_end : "",
    allowance,
    used,
    remaining,
    packCredits: finite(credits.pack_credits) ?? 0,
    packExpiresAt: typeof credits.pack_expires_at === "string" ? credits.pack_expires_at : undefined,
    frozen: credits.frozen === true,
  };
}

/** Credits carry one decimal: keep sums free of binary-float noise. */
function sumCredits(base: number | undefined, add: number | undefined): number {
  return Math.round(((base ?? 0) + (add ?? 0)) * 100) / 100;
}

/** A finite number from the wire, or undefined (strings, nulls and NaN from
 *  the gateway must never poison the sums). */
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


/** "2026-11-09" → "November 2026" (deterministic en-US, UTC month). */
function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split("-").map(Number);
  const name = Number.isFinite(year) && Number.isFinite(month)
    ? new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })
    : "";
  return `${name} ${year}`.trim();
}

export class UsageTracker {
  private snapshots = new Map<string, UsageSnapshot>();

  constructor(private readonly store: UsageStateStore = new MemoryUsageStore()) {}

  record(profile: string, modelId: string, report: UsageReport): UsageSnapshot {
    const current = this.snapshots.get(profile) ?? emptySnapshot();
    const models: Record<string, ModelUsage> = { ...current.models };
    const model = models[modelId] ?? { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    models[modelId] = {
      requests: model.requests + 1,
      promptTokens: model.promptTokens + report.promptTokens,
      completionTokens: model.completionTokens + report.completionTokens,
      cachedTokens: model.cachedTokens + report.cachedTokens,
    };
    const next: UsageSnapshot = {
      models,
      totalRequests: current.totalRequests + 1,
      totalTokens: current.totalTokens + report.promptTokens + report.completionTokens,
      updatedAt: Date.now(),
    };
    this.snapshots.set(profile, next);
    void this.persist(profile, next);
    return next;
  }

  noteRemote(profile: string, remote: RemoteUsage): void {
    const current = this.snapshots.get(profile) ?? emptySnapshot();
    this.snapshots.set(profile, { ...current, remote });
  }

  snapshot(profile: string): UsageSnapshot {
    return this.snapshots.get(profile) ?? emptySnapshot();
  }

  /** Restores persisted counters (called at activation). Waits for any
   *  pending record write so hydration never reads pre-write data. */
  async hydrate(profiles: readonly string[] = [DEFAULT_PROFILE]): Promise<void> {
    await this.persistChain;
    const persisted = await this.store.read();
    for (const profile of profiles) {
      const models = persisted[profile];
      if (!models) continue;
      const entries = Object.entries(models);
      this.snapshots.set(profile, {
        models,
        totalRequests: entries.reduce((sum, [, row]) => sum + row.requests, 0),
        totalTokens: entries.reduce(
          (sum, [, row]) => sum + row.promptTokens + row.completionTokens,
          0,
        ),
      });
    }
  }

  /** Persist operations are chained: a burst of records in one tick must
   *  never let a slow `read` interleave and drop another model's counters. */
  private persistChain: Promise<void> = Promise.resolve();

  private persist(profile: string, snapshot: UsageSnapshot): Promise<void> {
    const next = this.persistChain.then(async () => {
      try {
        const persisted = await this.store.read();
        persisted[profile] = snapshot.models;
        await this.store.write(persisted);
      } catch {
        /* persistence is best-effort; tracking continues in memory */
      }
    });
    // Keep the chain alive across failures and drop the resolved tail so the
    // chain reference cannot accumulate.
    this.persistChain = next.finally(() => undefined);
    return next;
  }
}

function emptySnapshot(): UsageSnapshot {
  return { models: {}, totalRequests: 0, totalTokens: 0 };
}
