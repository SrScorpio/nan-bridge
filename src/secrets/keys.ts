/**
 * API-key storage: one key per profile in VS Code SecretStorage.
 * Profile ids are lowercase slugs; `default` is the one-entry setup.
 */

import type * as vscode from "vscode";

const KEY_PREFIX = "nan-bridge.key.";
export const DEFAULT_PROFILE = "default";

export const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeProfile(raw: string | undefined): string {
  const value = (raw ?? "").trim().toLowerCase() || DEFAULT_PROFILE;
  if (!PROFILE_PATTERN.test(value)) {
    throw new Error(`Invalid profile id "${value}" (lowercase letters, digits, dot, dash, max 64)`);
  }
  return value;
}

/**
 * Extracts the profile from a returned model id. We hand the host
 * `profile::model` ids; the host may prefix its own qualification
 * (`vendor:profile::model`), so the profile is the last plain segment
 * before the `::` separator. Returns undefined when the id carries no
 * recognizable profile — the caller falls back to the active profile.
 */
export function profileFromModelId(modelId: string): string | undefined {
  const separator = modelId.lastIndexOf("::");
  if (separator <= 0) return undefined;
  const head = modelId.slice(0, separator);
  const candidate = head.split(/[:/]/).pop() ?? "";
  if (!PROFILE_PATTERN.test(candidate)) return undefined;
  // The model half must be present and non-empty.
  return modelId.slice(separator + 2) ? candidate : undefined;
}

function storageKey(profile: string): string {
  return `${KEY_PREFIX}${profile}`;
}

export async function readKey(secrets: vscode.SecretStorage, profile: string): Promise<string | undefined> {
  const value = await secrets.get(storageKey(profile));
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export async function writeKey(secrets: vscode.SecretStorage, profile: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await secrets.store(storageKey(profile), trimmed);
}

export async function eraseKey(secrets: vscode.SecretStorage, profile: string): Promise<void> {
  await secrets.delete(storageKey(profile));
}

/** Profiles that currently hold a key, sorted. */
export async function profilesWithKeys(secrets: vscode.SecretStorage): Promise<string[]> {
  return (await secrets.keys())
    .filter((entry) => entry.startsWith(KEY_PREFIX))
    .map((entry) => entry.slice(KEY_PREFIX.length))
    .sort();
}
