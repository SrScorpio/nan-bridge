/**
 * Token estimation for `provideTokenCount`: text by characters, images at a
 * flat 1024 (no model-specific vision tokenizer is exposed to us).
 */

const decoder = new TextDecoder();

export function estimateTokens(input: string | { readonly content: readonly unknown[] }): number {
  if (typeof input === "string") return Math.ceil(input.length / 4) + 4;
  return 8 + input.content.reduce<number>((total, part) => total + estimatePart(part), 0);
}

function estimatePart(part: unknown): number {
  if (typeof part !== "object" || part === null) return 0;
  const candidate = part as { value?: unknown; mimeType?: string; data?: unknown };
  const value = candidate.value;
  if (typeof value === "string") return Math.ceil(value.length / 4);
  if (typeof candidate.mimeType === "string" && candidate.data instanceof Uint8Array) {
    if (candidate.mimeType.startsWith("image/")) return 1024;
    if (candidate.mimeType.startsWith("text/")) return Math.ceil(decoder.decode(candidate.data).length / 4);
  }
  return 0;
}
