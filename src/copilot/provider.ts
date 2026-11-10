/**
 * The Copilot Chat provider: model information, chat responses and token
 * counts, all backed by one NaN API client per profile. The per-profile
 * client is cached so its slot queue spans concurrent requests — creating a
 * client per request would give every chat its own queue and let the
 * extension self-saturate the per-key parallel limit.
 */

import * as vscode from "vscode";
import { NaNApi } from "../gateway/api";
import { explain, ProviderError } from "../errors";
import { mergeCatalog, STATIC_MODELS, type CatalogEntry } from "../models/catalog";
import { TTLCache } from "../models/cache";
import { effortsForModel, defaultEffortFor, effortLabel, effortDescriptionsFor, clampEffort } from "../models/efforts";
import { contextSizeOptions } from "../models/context";
import { DEFAULT_PROFILE, normalizeProfile, profileFromModelId, readKey } from "../secrets/keys";
import { DEFAULT_API_BASE_URL, normalizeBaseUrl, userAgentFor, VENDOR_ID } from "../gateway/endpoints";
import { buildRequestBody } from "./request";
import { buildToolNameMap, restoreToolName } from "./tool-names";
import { ResponseProjector } from "./outbound";
import { estimateTokens } from "./tokens";
import type { UsageReport } from "./outbound";
import { UsageTracker, parseRemoteUsage, type UsageStateStore } from "../usage/tracker";

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

type ChatInformation = vscode.LanguageModelChatInformation & {
  readonly family: string;
  readonly version: string;
  readonly catalogEntry: CatalogEntry;
};

export interface ProviderEvents {
  onUsage(profile: string, report: UsageReport, modelId: string): void;
}

export class BridgeProvider implements vscode.LanguageModelChatProvider<ChatInformation> {
  private readonly apis = new Map<string, NaNApi>();
  private readonly catalogs = new Map<string, TTLCache<readonly CatalogEntry[]>>();
  private readonly tracker: UsageTracker;
  private activeProfile: string;
  private cachedStatic: readonly CatalogEntry[] | undefined;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly extensionVersion: string,
    private readonly vscodeVersion: string,
    private readonly events: ProviderEvents,
    usageStore?: UsageStateStore,
  ) {
    this.activeProfile = DEFAULT_PROFILE;
    this.tracker = new UsageTracker(usageStore);
  }

  /** Restores persisted usage counters after activation. */
  hydrateUsage(profiles?: readonly string[]): Promise<void> {
    const requested = profiles ?? [this.activeProfile, ...this.apis.keys()];
    return this.tracker.hydrate(Array.from(new Set([this.activeProfile, ...requested])));
  }

  setActiveProfile(raw: string): void {
    this.activeProfile = normalizeProfile(raw);
  }

  getActiveProfile(): string {
    return this.activeProfile;
  }

  /** Local + remote usage snapshot for the status bar. */
  usageSnapshot(profile = this.activeProfile) {
    return this.tracker.snapshot(profile);
  }

  /** Merges the gateway's own usage report (per model) into the local view. */
  async refreshRemoteUsage(profile = this.activeProfile): Promise<void> {
    const payload = await this.apiFor(profile).fetchUsage();
    const remote = parseRemoteUsage(payload);
    if (remote) this.tracker.noteRemote(profile, remote);
  }

  invalidateCatalog(profile = this.activeProfile): void {
    this.catalogFor(profile).clear();
  }

  private fallbackStatic(): readonly CatalogEntry[] {
    this.cachedStatic ??= mergeCatalog({ data: STATIC_MODELS.map((model) => ({ id: model.id })) });
    return this.cachedStatic;
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<ChatInformation[]> {
    // Entries are ALWAYS listed — VS Code shows a "Set NaN API Key" button on
    // them when the key is missing, instead of the vendor silently vanishing.
    // VS Code passes the account entry's `profile` in options.configuration.
    const configured = (options as { configuration?: Record<string, unknown> }).configuration;
    const rawProfile = configured?.profile;
    let profile = this.activeProfile;
    try {
      if (typeof rawProfile === "string" && rawProfile.trim()) profile = normalizeProfile(rawProfile);
    } catch {
      // A hand-edited configuration must not break listing for the vendor.
    }
    const hasKey = Boolean(await readKey(this.secrets, profile));
    let entries: readonly CatalogEntry[];
    if (!hasKey) {
      // No key: never touch the gateway (it would 401 before we can list
      // anything) — the static catalog carries the picker.
      entries = this.fallbackStatic();
    } else {
      try {
        entries = await this.catalogFor(profile).getOrRefresh(CATALOG_TTL_MS, async () => {
          if (token.isCancellationRequested) return [];
          return mergeCatalog(await this.apiFor(profile).listModels(abortSignalOf(token)));
        });
      } catch {
        // A dead gateway must not blank the picker: fall back to the static
        // catalog so models stay visible and errors surface on first use.
        entries = this.fallbackStatic();
      }
    }
    if (token.isCancellationRequested) return [];
    return entries.map((entry) => this.toInformation(entry, profile, hasKey));
  }

  async provideLanguageModelChatResponse(
    model: ChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const configuration = readModelConfiguration(
      options.modelConfiguration,
      vscode.workspace.getConfiguration("nanBridge").get<string | undefined>("reasoningEffort"),
    );
    // The selected id carries the profile it was listed under
    // (`profile::model`); fall back to the active one for bare ids.
    const profile = profileFromModelId(model.id) ?? this.activeProfile;
    const originalTools = options.tools ?? [];
    const toolNameMap = buildToolNameMap(originalTools.map((tool) => tool.name));
    const body = buildRequestBody(messages, {
      model: model.catalogEntry,
      // Request config wins; the workspace setting is the fallback; anything
      // the model does not support lands on its default level.
      effort: clampEffort(model.catalogEntry.id, configuration.effort),
      contextSize: configuration.contextSize,
      tools: originalTools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
      })),
      toolMode: options.toolMode,
    });
    const events = await this.apiFor(profile).openChat(body, abortSignalOf(token));
    const projector = new ResponseProjector(progress, {
      text: vscode.LanguageModelTextPart,
      thinking: vscode.LanguageModelThinkingPart,
      toolCall: vscode.LanguageModelToolCallPart,
      data: vscode.LanguageModelDataPart,
    }, (usage) => {
      this.tracker.record(profile, model.catalogEntry.id, usage);
      this.events.onUsage(profile, usage, model.catalogEntry.id);
    }, (name) => restoreToolName(toolNameMap, name));
    try {
      for await (const event of events) {
        if (token.isCancellationRequested) break;
        projector.handle(event);
      }
      projector.settle();
    } catch (error) {
      throw new Error(explain(error));
    }
  }

  provideTokenCount(
    _model: ChatInformation,
    input: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    if (typeof input === "string") return Promise.resolve(estimateTokens(input));
    return Promise.resolve(estimateTokens({ content: input.content }));
  }

  private apiFor(profile: string): NaNApi {
    let api = this.apis.get(profile);
    if (!api) {
      const config = vscode.workspace.getConfiguration("nanBridge");
      api = new NaNApi({
        key: () => readKey(this.secrets, profile),
        baseUrl: () => normalizeBaseUrl(config.get<string | undefined>("apiBaseUrl") ?? DEFAULT_API_BASE_URL),
        userAgent: () => userAgentFor(this.extensionVersion, this.vscodeVersion),
        connectTimeoutMs: () => config.get("requestConnectTimeoutSeconds", 20) * 1000,
        idleTimeoutMs: () => config.get("streamIdleTimeoutSeconds", 120) * 1000,
      });
      this.apis.set(profile, api);
    }
    return api;
  }

  private catalogFor(profile: string): TTLCache<readonly CatalogEntry[]> {
    let cache = this.catalogs.get(profile);
    if (!cache) {
      cache = new TTLCache<readonly CatalogEntry[]>();
      this.catalogs.set(profile, cache);
    }
    return cache;
  }

  private toInformation(entry: CatalogEntry, profile: string, hasKey: boolean): ChatInformation {
    const efforts = effortsForModel(entry.id);
    const contextOptions = contextSizeOptions(entry.contextTokens);
    return {
      // Profile-qualified local id: the same model under two NaN profiles
      // stays addressable as separate picker entries (VS Code adds the
      // vendor prefix itself).
      id: `${profile}::${entry.id}`,
      name: `${entry.label} (${profile})`,
      family: entry.family,
      version: entry.id,
      catalogEntry: entry,
      maxInputTokens: entry.inputTokens,
      maxOutputTokens: entry.outputTokens,
      tooltip: [
        entry.note,
        `Context ${entry.contextTokens.toLocaleString("en-US")} in / ${entry.outputTokens.toLocaleString("en-US")} out`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      capabilities: {
        imageInput: entry.vision,
        toolCalling: true,
      },
      isUserSelectable: true,
      requiresAuthorization: hasKey ? undefined : { label: "Set NaN API Key" },
      configurationSchema: {
        type: "object",
        properties: {
          reasoningEffort: {
            type: "string",
            title: "Reasoning Effort",
            enum: [...efforts],
            enumItemLabels: efforts.map((level) => effortLabel(level)),
            enumDescriptions: effortDescriptionsFor(entry.id),
            default: defaultEffortFor(entry.id),
            group: "navigation",
          },
          ...(contextOptions
            ? {
                contextSize: {
                  type: ["string", "number"],
                  title: "Context Window",
                  enum: contextOptions.map((option) => option.value),
                  enumItemLabels: contextOptions.map((option) => option.label),
                  enumDescriptions: contextOptions.map((option) => option.description),
                  default: "auto",
                  group: "tokens",
                },
              }
            : {}),
        },
      },
    } as ChatInformation;
  }
}

interface ModelConfiguration {
  readonly effort?: string;
  readonly contextSize?: number;
}

/** Reads the model configuration VS Code passes back from our schema. */
function readModelConfiguration(
  configuration: vscode.ProvideLanguageModelChatResponseOptions["modelConfiguration"],
  workspaceEffort?: string,
): ModelConfiguration {
  const raw = configuration as Record<string, unknown> | undefined;
  const effort = raw?.reasoningEffort ?? workspaceEffort;
  const contextSize = raw?.contextSize;
  return {
    effort: typeof effort === "string" ? effort : undefined,
    contextSize: typeof contextSize === "number" && Number.isFinite(contextSize) ? contextSize : undefined,
  };
}

/**
 * Bridges a VS Code cancellation token into an AbortSignal for the transport.
 * The disposable dies with the token's emitter, so nothing leaks per request.
 */
function abortSignalOf(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort(new Error("cancelled")));
  return controller.signal;
}
