/**
 * Command surface: key management, profile switching, connection test,
 * catalog refresh, usage display and a diagnostics dump. Every command logs
 * failures to the extension output channel instead of dying silently.
 */

import * as vscode from "vscode";
import { explain } from "../errors";
import { NAN_KEY_PORTAL_URL, NAN_MODEL_DOCS_URL, VENDOR_ID, DEFAULT_API_BASE_URL, normalizeBaseUrl } from "../gateway/endpoints";
import { DEFAULT_PROFILE, eraseKey, normalizeProfile, profilesWithKeys, writeKey } from "../secrets/keys";
import { quickPickRows } from "../usage/views";
import type { BridgeProvider } from "../copilot/provider";

export interface CommandDeps {
  readonly provider: BridgeProvider;
  readonly secrets: vscode.SecretStorage;
  readonly output: vscode.OutputChannel;
  readonly onKeysChanged: () => void;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { provider, output } = deps;
  const log = (line: string) => output.appendLine(line);
  const fail = (prefix: string) => (error: unknown) => {
    log(`[error] ${prefix}: ${explain(error)}`);
    void vscode.window.showErrorMessage(`NaN Bridge: ${explain(error)}`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("nanBridge.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: `NaN.Builders API key (${NAN_KEY_PORTAL_URL} → API Keys)`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      const profile = await pickProfile("Store key for profile", provider, context.secrets) ?? DEFAULT_PROFILE;
      try {
        await writeKey(context.secrets, profile, key);
        provider.invalidateCatalog(profile);
        log(`[auth] key stored for profile "${profile}"`);
        deps.onKeysChanged();
        void vscode.window.showInformationMessage(`NaN Bridge: key stored for "${profile}".`);
      } catch (error) {
        fail("set key")(error);
      }
    }),

    vscode.commands.registerCommand("nanBridge.clearApiKey", async () => {
      const profile = await pickProfile("Clear key for profile", provider, context.secrets) ?? DEFAULT_PROFILE;
      try {
        await eraseKey(context.secrets, profile);
        provider.invalidateCatalog(profile);
        log(`[auth] key cleared for profile "${profile}"`);
        deps.onKeysChanged();
        void vscode.window.showInformationMessage(`NaN Bridge: key cleared for "${profile}".`);
      } catch (error) {
        fail("clear key")(error);
      }
    }),

    vscode.commands.registerCommand("nanBridge.selectProfile", async () => {
      const profile = await vscode.window.showInputBox({
        prompt: "Profile id (lowercase letters, digits, dot, dash)",
        value: provider.getActiveProfile(),
        ignoreFocusOut: true,
      });
      if (!profile) return;
      try {
        provider.setActiveProfile(normalizeProfile(profile));
        log(`[profile] active → "${profile}"`);
        deps.onKeysChanged();
      } catch (error) {
        fail("select profile")(error);
      }
    }),

    vscode.commands.registerCommand("nanBridge.testConnection", async () => {
      const status = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "NaN Bridge: testing connection…" },
        async () => {
          const cancellation = new vscode.CancellationTokenSource();
          try {
            return await provider.provideLanguageModelChatInformation({ silent: true } as never, cancellation.token);
          } finally {
            cancellation.dispose();
          }
        },
      );
      if (status.length) {
        void vscode.window.showInformationMessage(
          `NaN Bridge: OK — ${status.length} models reachable (${status.map((entry) => entry.family).join(", ")}).`,
        );
      } else {
        void vscode.window.showWarningMessage("NaN Bridge: no models listed — check the API key for this profile.");
      }
    }),

    vscode.commands.registerCommand("nanBridge.refreshModels", () => {
      provider.invalidateCatalog();
      deps.onKeysChanged();
      void vscode.window.showInformationMessage("NaN Bridge: model catalog will refresh on next use.");
    }),

    vscode.commands.registerCommand("nanBridge.showUsage", async () => {
      await provider.refreshRemoteUsage().catch(() => undefined);
      // Read the snapshot AFTER the refresh: refreshRemoteUsage swaps in a
      // new snapshot object, so an earlier capture would show stale numbers.
      const rows: Array<vscode.QuickPickItem & { action?: "keys" | "docs" }> = [
        ...quickPickRows(provider.usageSnapshot()),
        { label: "Actions", kind: vscode.QuickPickItemKind.Separator },
        { label: "$(globe) Open API Keys Page", action: "keys" },
        { label: "$(book) Open Model Docs", action: "docs" },
      ];
      const pick = await vscode.window.showQuickPick(rows, {
        title: "NaN Bridge usage",
        placeHolder: "Gateway-side usage for this key — all clients included",
      });
      if (pick?.action === "keys") await vscode.env.openExternal(vscode.Uri.parse(NAN_KEY_PORTAL_URL));
      else if (pick?.action === "docs") await vscode.env.openExternal(vscode.Uri.parse(NAN_MODEL_DOCS_URL));
      else if (pick) log(`[usage] ${pick.label.replace(/\$\([^)]*\) /, "")} — ${pick.detail ?? ""}`);
    }),

    vscode.commands.registerCommand("nanBridge.diagnostics", async () => {
      // Ask the host what it actually sees, not what we think we registered.
      const models = await Promise.resolve(vscode.lm.selectChatModels({ vendor: VENDOR_ID })).catch(() => []);
      const profiles = await profilesWithKeys(context.secrets).catch(() => []);
      const baseUrl = normalizeBaseUrl(vscode.workspace.getConfiguration("nanBridge").get<string | undefined>("apiBaseUrl") ?? DEFAULT_API_BASE_URL);
      const content = [
        "# NaN Bridge diagnostics",
        "",
        `- VS Code: ${vscode.version}`,
        `- Extension: ${vscode.extensions.getExtension("SrScorpio.nan-bridge")?.packageJSON.version ?? "?"}`,
        `- API base URL: ${baseUrl}`,
        `- Active profile: ${provider.getActiveProfile()}`,
        `- Profiles with stored keys: ${profiles.length ? profiles.join(", ") : "none"} (key material never shown)`,
        `- Models visible to the host: ${models.length}`,
        "",
        ...models.map((model: vscode.LanguageModelChat) => `- ${model.id} — ${model.name} (${model.maxInputTokens?.toLocaleString("en-US") ?? "?"} input tokens)`),
        "",
        `- Tracked locally: ${Object.keys(provider.usageSnapshot().models).join(", ") || "none"}`,
        `- Docs: ${NAN_MODEL_DOCS_URL}`,
      ].join("\n");
      log(`[diagnostics] host models=${models.length} profiles=${profiles.length}`);
      try {
        const document = await vscode.workspace.openTextDocument({ content, language: "markdown" });
        await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
      } catch {
        output.appendLine(content);
        output.show();
      }
    }),
  );
}

async function pickProfile(title: string, provider: BridgeProvider, secrets: vscode.SecretStorage): Promise<string | undefined> {
  const known = await profilesWithKeys(secrets).catch(() => []);
  const options = Array.from(new Set([provider.getActiveProfile(), DEFAULT_PROFILE, ...known]));
  const chosen = await vscode.window.showQuickPick(options.map((profile) => ({ label: profile })), {
    title,
    ignoreFocusOut: true,
  });
  return chosen?.label;
}
