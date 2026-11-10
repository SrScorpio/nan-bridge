/**
 * Presentation of usage state: status-bar text/tooltip and quick-pick rows.
 * All numbers use `en-US` grouping — never bare `toLocaleString()`, which
 * changes with the runtime locale and breaks expectations between machines.
 */

import { monthlyQuotaFor } from "../models/catalog";
import type { RemoteModelUsage, UsageSnapshot } from "./tracker";

export function statusText(snapshot: UsageSnapshot): string {
  const remote = snapshot.remote;
  if (!remote) return "NaN: usage —";
  if (remote.month) return `NaN: ${compact(remote.month.totalTokens)} tok this month`;
  return `NaN: ${compact(remote.requests)} req · ${compact(remote.totalTokens)} tok`;
}

export function statusTooltip(snapshot: UsageSnapshot): string {
  const remote = snapshot.remote;
  if (!remote) {
    return "NaN Bridge — gateway usage not available yet.\nReopen the usage panel or send a chat message to refresh.";
  }
  const lines = [
    `NaN gateway usage — ${remote.requests.toLocaleString("en-US")} requests · ` +
      `${remote.totalTokens.toLocaleString("en-US")} tokens (all clients on this key)`,
    `Period ${remote.startDate} → ${remote.endDate}`,
  ];
  if (remote.month) {
    lines.push(
      `This month (${remote.month.label}): ${remote.month.requests.toLocaleString("en-US")} requests · ` +
        `${remote.month.totalTokens.toLocaleString("en-US")} tokens`,
    );
  }
  lines.push("");
  for (const row of (remote.month?.byModel ?? remote.byModel).slice(0, 8)) {
    lines.push(`${row.model}: ${row.requests.toLocaleString("en-US")} req · ` +
      `${row.totalTokens.toLocaleString("en-US")} tok${quotaSuffix(row)}`);
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
    detail: `${row.totalTokens.toLocaleString("en-US")} tokens${quotaSuffix(row)}`,
  }));
  if (remote.month) {
    return [
      {
        label: `$(calendar) This month — ${remote.month.label}`,
        description: `${remote.month.requests.toLocaleString("en-US")} requests`,
        detail: `${remote.month.totalTokens.toLocaleString("en-US")} tokens`,
      },
      ...rows,
      {
        label: `$(cloud) Window total — ${remote.requests.toLocaleString("en-US")} requests`,
        description: `${remote.totalTokens.toLocaleString("en-US")} tokens`,
        detail: `All clients on this key · ${remote.startDate} → ${remote.endDate}`,
      },
    ];
  }
  return [
    {
      label: `$(cloud) Gateway total — ${remote.requests.toLocaleString("en-US")} requests`,
      description: `${remote.totalTokens.toLocaleString("en-US")} tokens`,
      detail: `All clients on this key · ${remote.startDate} → ${remote.endDate}`,
    },
    ...rows,
  ];
}

/** " — 4.1% of 2B allowance" when the model has a documented monthly quota. */
function quotaSuffix(row: RemoteModelUsage): string {
  const quota = monthlyQuotaFor(row.model);
  if (!quota) return "";
  const percent = Math.round((row.totalTokens / quota) * 1000) / 10;
  return ` — ${percent}% of ${compact(quota)} allowance`;
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
