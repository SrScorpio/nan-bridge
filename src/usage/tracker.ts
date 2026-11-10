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
}

export interface RemoteUsage {
  readonly startDate: string;
  readonly endDate: string;
  readonly requests: number;
  readonly totalTokens: number;
  readonly byModel: readonly RemoteModelUsage[];
  /** Calendar-month slice of the window (from the rows dated in the month
   *  of `endDate`), so the panel can show spend-to-date and quotas. */
  readonly month?: RemoteMonthUsage;
}

export interface RemoteMonthUsage {
  /** e.g. "November 2026" (en-US, derived from the report's end date). */
  readonly label: string;
  readonly requests: number;
  readonly totalTokens: number;
  readonly byModel: readonly RemoteModelUsage[];
}

/**
 * Parses the gateway's `/usage` report (`usage.report` object: daily rows
 * per model) into a per-model aggregate. Returns undefined when the payload
 * carries no usable rows.
 */
export function parseRemoteUsage(payload: unknown): RemoteUsage | undefined {
  const report = payload as
    | {
        start_date?: unknown;
        end_date?: unknown;
        data?: Array<{ date?: unknown; model?: unknown; api_requests?: unknown; total_tokens?: unknown } | null>;
      }
    | null;
  const rows = Array.isArray(report?.data) ? report.data : [];
  if (!rows.length) return undefined;
  const byModel = new Map<string, RemoteModelUsage>();
  let requests = 0;
  let totalTokens = 0;
  // The calendar-month slice: rows dated in the month of the report's end
  // date (the gateway's clock, immune to the local machine's timezone).
  const endDate = typeof report?.end_date === "string" ? report.end_date : "";
  const monthPrefix = endDate.slice(0, 7);
  const monthByModel = new Map<string, RemoteModelUsage>();
  let monthRequests = 0;
  let monthTokens = 0;
  let monthRows = 0;
  for (const row of rows) {
    const model = typeof row?.model === "string" ? row.model : "";
    if (!model) continue;
    const rowRequests = typeof row?.api_requests === "number" ? row.api_requests : 0;
    const rowTokens = typeof row?.total_tokens === "number" ? row.total_tokens : 0;
    const current = byModel.get(model) ?? { model, requests: 0, totalTokens: 0 };
    byModel.set(model, {
      model,
      requests: current.requests + rowRequests,
      totalTokens: current.totalTokens + rowTokens,
    });
    requests += rowRequests;
    totalTokens += rowTokens;
    if (typeof row?.date === "string" && row.date.startsWith(monthPrefix)) {
      const monthCurrent = monthByModel.get(model) ?? { model, requests: 0, totalTokens: 0 };
      monthByModel.set(model, {
        model,
        requests: monthCurrent.requests + rowRequests,
        totalTokens: monthCurrent.totalTokens + rowTokens,
      });
      monthRequests += rowRequests;
      monthTokens += rowTokens;
      monthRows += 1;
    }
  }
  if (!byModel.size) return undefined;
  return {
    startDate: typeof report?.start_date === "string" ? report.start_date : "",
    endDate,
    requests,
    totalTokens,
    byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests),
    month: monthRows
      ? {
          label: monthLabel(endDate),
          requests: monthRequests,
          totalTokens: monthTokens,
          byModel: [...monthByModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
        }
      : undefined,
  };
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
