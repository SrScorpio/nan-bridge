/**
 * Extension entry point: wires the provider, commands and usage status bar,
 * and registers the language-model provider under the `nan-builders` vendor.
 */

import * as vscode from "vscode";
import { BridgeProvider } from "./copilot/provider";
import { registerCommands } from "./commands";
import type { UsageStateStore } from "./usage/tracker";
import { statusText, statusTooltip } from "./usage/views";
import { DEFAULT_API_BASE_URL, EXTENSION_DISPLAY_NAME, VENDOR_ID } from "./gateway/endpoints";
import { DEFAULT_PROFILE } from "./secrets/keys";

const USAGE_STATE_KEY = "nan-bridge.usage";

class GlobalStateUsageStore implements UsageStateStore {
  constructor(private readonly state: vscode.Memento) {}

  async read() {
    return (this.state.get<Record<string, never>>(USAGE_STATE_KEY) ?? {}) as never;
  }

  async write(value: never) {
    await this.state.update(USAGE_STATE_KEY, value as unknown as never);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(EXTENSION_DISPLAY_NAME);
  const extensionVersion = context.extension.packageJSON.version as string;
  /** Pulls the gateway-side usage report and re-renders the status bar.
   *  Skips while a refresh is already in flight — agent loops call this
   *  once per turn, and parallel /usage fetches would pile up. */
  let usageRefreshInFlight = false;
  function refreshUsage(): void {
    if (usageRefreshInFlight) return;
    usageRefreshInFlight = true;
    void provider
      .refreshRemoteUsage()
      .then(renderUsage)
      .catch(() => undefined)
      .finally(() => {
        usageRefreshInFlight = false;
      });
  }

  const provider = new BridgeProvider(
    context.secrets,
    extensionVersion,
    vscode.version,
    { onUsage: () => refreshUsage() },
    new GlobalStateUsageStore(context.globalState),
  );
  // Re-point the tracker at the profile the user last used BEFORE hydrating,
  // so the restored counters land in the right bucket.
  const lastProfile = context.globalState.get<string>("nan-bridge.profile");
  if (lastProfile) provider.setActiveProfile(lastProfile);
  void provider.hydrateUsage([provider.getActiveProfile(), DEFAULT_PROFILE]).then(refreshUsage);
  context.subscriptions.push({
    dispose: () => void context.globalState.update("nan-bridge.profile", provider.getActiveProfile()),
  });

  const usageStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  usageStatus.name = "NaN Bridge usage";
  usageStatus.command = "nanBridge.showUsage";
  context.subscriptions.push(usageStatus);

  function renderUsage(): void {
    const snapshot = provider.usageSnapshot();
    usageStatus.text = `$(sparkle) ${statusText(snapshot)}`;
    usageStatus.tooltip = new vscode.MarkdownString(statusTooltip(snapshot));
    if (vscode.workspace.getConfiguration("nanBridge").get<boolean>("showUsageStatusBar", true)) {
      usageStatus.show();
    } else {
      usageStatus.hide();
    }
  }

  function keysChanged(): void {
    renderUsage();
    void Promise.resolve(vscode.commands.executeCommand("workbench.action.chat.manageLanguageModels")).catch(() => undefined);
  }

  context.subscriptions.push(
    output,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nanBridge")) keysChanged();
    }),
    vscode.commands.registerCommand("nanBridge.manage", () => keysChanged()),
    vscode.commands.registerCommand("nanBridge.configureEntry", () => keysChanged()),
    vscode.commands.registerCommand("nanBridge.addAccount", () => keysChanged()),
  );

  registerCommands(context, {
    provider,
    secrets: context.secrets,
    output,
    onKeysChanged: keysChanged,
  });

  // Provider construction done; expose the vendor to Copilot Chat.
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider));

  output.appendLine(
    `[activate] ${EXTENSION_DISPLAY_NAME} ${extensionVersion} on VS Code ${vscode.version} — base ${DEFAULT_API_BASE_URL}, profile "${provider.getActiveProfile()}"`,
  );
  renderUsage();

  // Prompt the host to (re)discover our entries after startup settles.
  void Promise.resolve(
    vscode.commands.executeCommand("workbench.action.chat.manageLanguageModels"),
  ).catch(() => undefined);
}

export function deactivate(): void {
  /* subscriptions clean up automatically */
}
