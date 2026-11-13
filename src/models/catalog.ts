/**
 * Hybrid model catalog: curated metadata for known NaN chat models (the
 * live `/models` directory only carries ids) merged with whatever the
 * gateway lists today. Curated data mirrors the gateway's published limits;
 * unknown-but-listed chat ids still appear with conservative generic
 * metadata so new models surface before we update this table.
 */

export interface ModelDescriptor {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly contextTokens: number;
  readonly outputTokens: number;
  readonly vision: boolean;
  /** Picker order: lower first. */
  readonly priority: number;
  readonly note: string;
}

const ONE_M = 1_048_576;

/** Known chat models, in picker-preference order. */
export const STATIC_MODELS: readonly ModelDescriptor[] = [
  {
    id: "glm5.3", label: "GLM 5.3", family: "glm",
    contextTokens: ONE_M, outputTokens: 262_144, vision: true, priority: 10,
    note: "MoE ~753B premium flagship; vision, audio and video input.",
  },
  {
    id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", family: "deepseek",
    contextTokens: ONE_M, outputTokens: 262_144, vision: true, priority: 20,
    note: "MoE 305B fast general model; vision input.",
  },
  {
    id: "glm5.3-flash", label: "GLM 5.3 Flash", family: "glm",
    contextTokens: ONE_M, outputTokens: 262_144, vision: true, priority: 30,
    note: "MoE 320B fast GLM; vision input.",
  },
  {
    id: "qwen3.8-flash", label: "Qwen 3.8 Flash", family: "qwen",
    contextTokens: ONE_M, outputTokens: 262_144, vision: true, priority: 40,
    note: "MoE 125B fast Qwen; vision input.",
  },
  {
    id: "mimo-v2.6-flash", label: "MiMo v2.6 Flash", family: "mimo",
    contextTokens: ONE_M, outputTokens: 262_144, vision: true, priority: 50,
    note: "Omnimodal model with audio input; vision input.",
  },
  {
    id: "gemma4", label: "Gemma 4", family: "gemma",
    contextTokens: 262_144, outputTokens: 65_536, vision: true, priority: 60,
    note: "MoE 26B compact model; vision input.",
  },
  {
    id: "qwen3.6", label: "Qwen 3.6 (legacy)", family: "qwen",
    contextTokens: 262_144, outputTokens: 65_536, vision: true, priority: 70,
    note: "MoE 35B legacy Qwen; vision input.",
  },
];

/** Model ids on the gateway that are not chat-completion models. */
const NON_CHAT = /embed|whisper|tts|rerank|flux|image|kokoro|video|guard|minimax|speech|transcri|asr|moderation/i;

export interface CatalogEntry extends ModelDescriptor {
  readonly live: boolean;
  /** Input budget for the picker: output kept aside, 90% safety headroom. */
  readonly inputTokens: number;
}

export function inputBudgetFor(contextTokens: number, outputTokens: number): number {
  return Math.max(1, Math.min(contextTokens - outputTokens, Math.floor(contextTokens * 0.9)));
}

/**
 * Merges the live `/models` payload with static metadata.
 * - Known chat ids keep their curated numbers, ordered by preference.
 * - Unknown chat ids from the directory follow, with conservative metadata.
 * Throws when the payload has no usable chat model for this key.
 */
export function mergeCatalog(livePayload: unknown): readonly CatalogEntry[] {
  const ids = extractModelIds(livePayload);
  const known = new Map(STATIC_MODELS.map((model) => [model.id, model]));
  const curated: CatalogEntry[] = [];
  const liveOnly: CatalogEntry[] = [];

  for (const id of ids) {
    const model = known.get(id);
    if (model) {
      curated.push({ ...model, live: true, inputTokens: inputBudgetFor(model.contextTokens, model.outputTokens) });
    } else {
      liveOnly.push(genericEntry(id));
    }
  }
  curated.sort((a, b) => a.priority - b.priority);

  // A directory with no chat ids at all falls back to the static catalog so
  // a transient directory outage never empties the picker.
  if (!curated.length && !liveOnly.length) return staticCatalog();
  return [...curated, ...liveOnly.sort((a, b) => a.id.localeCompare(b.id))];
}

/** Catalog for offline/no-key contexts: static entries only. */
export function staticCatalog(): readonly CatalogEntry[] {
  return STATIC_MODELS.map((model) => ({
    ...model,
    live: false,
    inputTokens: inputBudgetFor(model.contextTokens, model.outputTokens),
  }));
}

function genericEntry(id: string): CatalogEntry {
  const family = id.replace(/[0-9.].*$/, "");
  return {
    id,
    label: prettify(id),
    family: family || id,
    contextTokens: 128_000,
    outputTokens: 16_384,
    vision: false,
    priority: 1_000,
    note: "Newly listed model — running with generic limits until curated.",
    live: true,
    inputTokens: inputBudgetFor(128_000, 16_384),
  };
}

function prettify(id: string): string {
  return id
    .split(/[-_.]/)
    .map((part) => (part === "flash" ? "Flash" : part.toUpperCase()))
    .join(" ");
}

function extractModelIds(payload: unknown): string[] {
  const container = payload as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
  const rows = Array.isArray(container) ? container : container?.data;
  if (!Array.isArray(rows)) throw new Error("The gateway model directory is missing its data array");
  return rows
    .map((row) => (typeof row?.id === "string" ? row.id : ""))
    .filter((id) => id && !NON_CHAT.test(id));
}
