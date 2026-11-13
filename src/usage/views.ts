/**
 * Presentation of usage state: status-bar text/tooltip and quick-pick rows.
 * All numbers use `en-US` grouping — never bare `toLocaleString()`, which
 * changes with the runtime locale and breaks expectations between machines.
 */

import type { RemoteCredits, RemoteModelUsage, UsageSnapshot } from "./tracker";

export function statusText(snapshot: UsageSnapshot): string {
  const remote = snapshot.remote;
  if (!remote) return "NaN: usage —";
  // Billing is credit-based since 2026-11-10: credits are the figure that
  // actually matters, tokens are only a proxy when credits are unavailable.
  if (remote.period) return `NaN: ${credits(remote.period.used)}/${credits(remote.period.allowance)} cr`;
  if (remote.month) return `NaN: ${compact(remote.month.totalTokens)} tok this month`;
  return `NaN: ${compact(remote.requests)} req · ${compact(remote.totalTokens)} tok`;
}

export function statusTooltip(snapshot: UsageSnapshot): string {
  const remote = snapshot.remote;
  if (!remote) {
    return "NaN Bridge — gateway usage not available yet.\nReopen the usage panel or send a chat message to refresh.";
  }
  const lines: string[] = [];
  const period = remote.period;
  if (period) lines.push(...creditsLines(period));
  if (period) lines.push("");
  lines.push(
    `NaN gateway usage — ${remote.requests.toLocaleString("en-US")} requests · ` +
      `${remote.totalTokens.toLocaleString("en-US")} tokens (all clients on this key)` +
      (remote.credits !== undefined ? ` · ${credits(remote.credits)} credits` : ""),
    `Period ${remote.startDate} → ${remote.endDate}`,
  );
  if (remote.month) {
    lines.push(
      `This month (${remote.month.label}): ${remote.month.requests.toLocaleString("en-US")} requests · ` +
        `${remote.month.totalTokens.toLocaleString("en-US")} tokens` +
        (remote.month.credits !== undefined ? ` · ${credits(remote.month.credits)} credits` : ""),
    );
  }
  lines.push("");
  for (const row of (remote.month?.byModel ?? remote.byModel).slice(0, 8)) {
    lines.push(`${row.model}: ${row.requests.toLocaleString("en-US")} req · ` +
      `${row.totalTokens.toLocaleString("en-US")} tok${creditsSuffix(row)}`);
  }
  if (snapshot.updatedAt) lines.push("", `Updated ${new Date(snapshot.updatedAt).toLocaleString("en-US")}`);
  return lines.join("\n");
}

export interface UsageRow {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

export function quickPickRows(snapshot: UsageSnapshot): readonly UsageRow[] {
  const remote = snapshot.remote;
  if (!remote) {
    return [{
      label: "No gateway usage reported yet",
      description: "",
      detail: "Chat with a NaN model, or reopen this panel in a moment.",
    }];
  }
  const rows: UsageRow[] = (remote.month?.byModel ?? remote.byModel.slice(0, 10)).slice(0, 10).map((row) => ({
    label: `$(cloud) ${row.model}`,
    description: `${row.requests.toLocaleString("en-US")} requests`,
    detail: `${row.totalTokens.toLocaleString("en-US")} tokens${creditsSuffix(row)}`,
  }));
  const period = remote.period;
  const lead: UsageRow[] = period
    ? [{
        label: `$(credit-card) Credits — ${periodLabel(period)}`,
        description: `${credits(period.used)} / ${credits(period.allowance)} used`,
        detail: `${credits(period.remaining)} remaining${packSuffix(period)}` +
          (period.frozen ? " · subscription inactive" : ""),
      }]
    : [];
  if (remote.month) {
    return [
      ...lead,
      {
        label: `$(calendar) This month — ${remote.month.label}`,
        description: `${remote.month.requests.toLocaleString("en-US")} requests`,
        detail: `${remote.month.totalTokens.toLocaleString("en-US")} tokens` +
          (remote.month.credits !== undefined ? ` · ${credits(remote.month.credits)} credits` : ""),
      },
      ...rows,
      {
        label: `$(cloud) Window total — ${remote.requests.toLocaleString("en-US")} requests`,
        description: `${remote.totalTokens.toLocaleString("en-US")} tokens`,
        detail: `All clients on this key · ${remote.startDate} → ${remote.endDate}` +
          (remote.credits !== undefined ? ` · ${credits(remote.credits)} credits` : ""),
      },
    ];
  }
  return [
    ...lead,
    {
      label: `$(cloud) Gateway total — ${remote.requests.toLocaleString("en-US")} requests`,
      description: `${remote.totalTokens.toLocaleString("en-US")} tokens`,
      detail: `All clients on this key · ${remote.startDate} → ${remote.endDate}` +
        (remote.credits !== undefined ? ` · ${credits(remote.credits)} credits` : ""),
    },
    ...rows,
  ];
}

/** Billing-period block for the tooltip: allowance, spend, packs, warnings. */
function creditsLines(period: RemoteCredits): string[] {
  const spent = period.allowance > 0 ? Math.round((period.used / period.allowance) * 1000) / 10 : 0;
  const lines = [
    `NaN credits — billing period ${dayLabel(period.periodStart)} → ${dayLabel(period.periodEnd)}`,
    `${credits(period.used)} of ${credits(period.allowance)} used (${spent}%) · ${credits(period.remaining)} remaining`,
  ];
  if (period.packCredits > 0 || period.packExpiresAt) {
    lines.push(
      `Pack credits: ${credits(period.packCredits)}` +
        (period.packExpiresAt ? ` (expire ${dayLabel(period.packExpiresAt)})` : ""),
    );
  }
  if (period.frozen) lines.push("⚠ Subscription inactive — credit-billed requests are refused until it is restored.");
  return lines;
}

/** " — 26.1 cr" when the gateway billed credits for this model. */
function creditsSuffix(row: RemoteModelUsage): string {
  return row.credits === undefined ? "" : ` — ${credits(row.credits)} cr`;
}

function packSuffix(period: RemoteCredits): string {
  return period.packCredits > 0 ? ` · packs ${credits(period.packCredits)}` : "";
}

/** ISO 8601 timestamp → "2026-11-16" (UTC, deterministic). */
function dayLabel(value: string): string {
  return value.slice(0, 10) || "—";
}

/** ISO 8601 timestamp → "2026-11-16 → 2026-12-16" inputs, shortened. */
function periodLabel(period: RemoteCredits): string {
  return `${shortDay(period.periodStart)} → ${shortDay(period.periodEnd)}`;
}

/** "2026-11-16T10:00:00Z" → "Nov 16" (UTC month/day, en-US). */
function shortDay(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return "—";
  return `${new Date(Date.UTC(year, month - 1, day)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${day}`;
}

/** Credits are billed with one decimal; keep it deterministic. */
function credits(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** 12,345 → "12.3k"; 3,660,000,000 → "3.7B"; deterministic compacting. */
function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${trim(value / 1000)}k`;
  if (value < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000)}B`;
}

function trim(value: number): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return String(rounded);
}
