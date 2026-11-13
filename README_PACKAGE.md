# NaN Bridge for Copilot Chat

Use NaN.Builders open models in GitHub Copilot Chat with your own NaN API key.

## Install

1. Download the latest `.vsix` from the GitHub releases page.
2. In VS Code: Extensions view → `…` menu → **Install from VSIX…** → pick the file.
3. Run the command **NaN Bridge: Set API Key** and paste a key from your NaN.Builders account.
4. Open Copilot Chat's model picker and choose a model under the **NaN** vendor.

## Commands

- **Set API Key** — store the key per profile in VS Code secret storage
- **Clear API Key** — remove a profile's key
- **Select Profile** — switch active profile
- **Test Connection** — verify the key by listing models
- **Refresh Models** — re-fetch the model catalog
- **Show Usage** — credits used and remaining for the billing period, plus per-model spend and tokens
- **Show Diagnostics** — state dump in the output channel

## Settings

- `nanBridge.apiBaseUrl` (default `https://api.nan.builders/v1`) — gateway endpoint
- `nanBridge.requestConnectTimeoutSeconds` (default 20) — wait for response headers
- `nanBridge.streamIdleTimeoutSeconds` (default 120) — silence limit on an open stream; long turns are never cut by a total deadline
- `nanBridge.showUsageStatusBar` (default true) — status-bar usage item
- `nanBridge.reasoningEffort` (default `medium`) — default effort for reasoning models; the in-chat picker overrides it

## Notes

The gateway limits parallel requests per key; prefer one key per editor. Streaming, reasoning traces and tool calling are supported, including agent mode.

MIT licensed. Independent rebuild with an MIT-licensed foundation from grikomsn/openai-oauth-copilot-chat; see NOTICE.md.
