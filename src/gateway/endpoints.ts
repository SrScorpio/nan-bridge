/**
 * NaN.Builders gateway endpoints and protocol constants.
 * Everything that knows a URL lives here.
 */

export const DEFAULT_API_BASE_URL = "https://api.nan.builders/v1";

/** Where users create and rotate API keys. */
export const NAN_KEY_PORTAL_URL = "https://cloud.nan.builders";

/** Public model catalog documentation. */
export const NAN_MODEL_DOCS_URL = "https://nan.builders/docs/models";

export const EXTENSION_DISPLAY_NAME = "NaN Bridge for Copilot Chat";

export const VENDOR_ID = "nan-builders";

/** Trims trailing slashes so path joining never produces `//`. */
export function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_API_BASE_URL;
  return value.replace(/\/+$/, "");
}

/** Stable user agent so NaN can identify bridge traffic. */
export function userAgentFor(version: string, vscodeVersion: string): string {
  return `nan-bridge/${version} VSCode/${vscodeVersion}`;
}
