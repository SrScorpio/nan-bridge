/**
 * Context-window selection: tiers the UI offers per model and how a chosen
 * tier caps the input budget before history trimming. "auto" (and any
 * non-positive or full-size value) leaves the model's own limit untouched.
 */

export const CONTEXT_SIZE_TIERS: readonly { value: number; label: string }[] = [
  { value: 65_536, label: "64K" },
  { value: 131_072, label: "128K" },
  { value: 200_000, label: "200K" },
];

export interface ContextSizeOption {
  readonly value: string | number;
  readonly label: string;
  readonly description: string;
}

/** Tiered options for models whose window exceeds the smallest tier. */
export function contextSizeOptions(maxInputTokens: number): readonly ContextSizeOption[] | undefined {
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= CONTEXT_SIZE_TIERS[0].value) return undefined;
  const tiers = CONTEXT_SIZE_TIERS.filter((tier) => tier.value < maxInputTokens);
  if (!tiers.length) return undefined;
  return [
    { value: "auto", label: "Auto", description: "Default context handling for this model." },
    ...tiers.map((tier) => ({
      value: tier.value,
      label: tier.label,
      description: `Keep the conversation under ${tier.label} input tokens.`,
    })),
    {
      value: maxInputTokens,
      label: "Maximum",
      description: "Use the model's full available input limit.",
    },
  ];
}

/**
 * Caps the input budget for a chosen tier. Only strictly smaller-than-max
 * sizes return a cap: "auto", 0, negative or full-window values mean "let the
 * model decide", matching how VS Code treats the contextSize setting.
 */
export function resolveContextCap(contextSize: number, maxInputTokens: number): number | undefined {
  if (!Number.isFinite(contextSize) || contextSize <= 0) return undefined;
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) return undefined;
  const cap = Math.min(Math.floor(contextSize), maxInputTokens);
  return cap < maxInputTokens ? cap : undefined;
}
