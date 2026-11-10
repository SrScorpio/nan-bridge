/**
 * Reasoning-effort ladder exposed by NaN, and the per-family remaps the
 * gateway actually accepts. Data-driven on purpose: adding a family is a table
 * edit, not a code change.
 */

export const EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** model family prefix → effort remap applied before sending. */
const FAMILY_REMAPS: Readonly<Record<string, Partial<Record<EffortLevel, EffortLevel>>>> = {
  // GLM has no "none": lift it to the nearest real level.
  glm: { none: "minimal" },
  // MiMo drops both extremes.
  mimo: { minimal: "low", xhigh: "max" },
};

/** Maps a UI effort to what the model behind `modelId` understands. */
export function effortForModel(modelId: string, effort: EffortLevel): EffortLevel {
  const family = Object.keys(FAMILY_REMAPS).find((prefix) => modelId.startsWith(prefix));
  if (!family) return effort;
  return FAMILY_REMAPS[family]![effort] ?? effort;
}

/** Levels offered for a model, with unsupported ends trimmed. */
export function effortsForModel(modelId: string): readonly EffortLevel[] {
  const family = Object.keys(FAMILY_REMAPS).find((prefix) => modelId.startsWith(prefix));
  if (!family) return EFFORT_LEVELS;
  const remap = FAMILY_REMAPS[family]!;
  return EFFORT_LEVELS.map((level) => remap[level] ?? level).filter(
    (level, index, all) => all.indexOf(level) === index,
  );
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** One-line copy shown under each level in the model configuration UI. */
export const EFFORT_DESCRIPTIONS: Readonly<Record<EffortLevel, string>> = {
  none: "Answer directly, no reasoning.",
  minimal: "Barely think before answering.",
  low: "Light reasoning for quick tasks.",
  medium: "Balanced reasoning for everyday work.",
  high: "Deeper reasoning for complex tasks.",
  xhigh: "Very deep reasoning, slower and heavier.",
  max: "Maximum reasoning effort.",
};

/** Descriptions for a model's picker: generic copy plus its special notes. */
export function effortDescriptionsFor(modelId: string): string[] {
  const notes = STATIC_NOTES.find(([prefix]) => modelId.startsWith(prefix))?.[1] ?? {};
  return effortsForModel(modelId).map((level) => notes[level] ?? EFFORT_DESCRIPTIONS[level]);
}

/**
 * Per-model overrides for picker descriptions. Keys must match levels the
 * model actually offers (see effortsForModel) — a note on a level the ladder
 * trims away would never render.
 */
const STATIC_NOTES: ReadonlyArray<readonly [string, Readonly<Partial<Record<EffortLevel, string>>>]> = [
  ["glm", { minimal: "Closest to none: GLM models never fully stop reasoning" }],
  ["deepseek", { none: "Fully disables reasoning on this model" }],
  ["mimo", { low: "Closest to minimal on this model", max: "Reasoning counts inside max_tokens on this model" }],
  ["gemma", { minimal: "Turns reasoning off on this model, like none" }],
  ["qwen3.6", { minimal: "Turns reasoning off on this model, like none" }],
  ["qwen3.8", { none: "Turns reasoning off (it is on by default for this model)" }],
];

/** Clamps a requested level to what the model offers (default if invalid). */
export function clampEffort(modelId: string, requested: string | undefined): EffortLevel {
  const levels = effortsForModel(modelId);
  if (requested && isEffortLevel(requested) && levels.includes(requested)) return requested;
  return defaultEffortFor(modelId);
}

/** "medium" → "Medium", for picker labels. */
export function effortLabel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** Default level per model: medium when offered, else the middle of its range. */
export function defaultEffortFor(modelId: string): EffortLevel {
  const levels = effortsForModel(modelId);
  return levels.includes("medium") ? "medium" : levels[Math.floor((levels.length - 1) / 2)];
}
