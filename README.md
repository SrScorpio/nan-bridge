# NaN Bridge for Copilot Chat

[![Built with NaN](https://nan.builders/badge/built-with-nan-compact.svg)](https://nan.builders/?ref=built-with-nan)
[![CI](https://github.com/SrScorpio/nan-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/SrScorpio/nan-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v1.0.0-7D39EB)](https://github.com/SrScorpio/nan-bridge/releases/latest)

Bring [NaN.Builders](https://nan.builders/?ref=built-with-nan) open models — GLM, Qwen, DeepSeek, Gemma and more — into GitHub Copilot Chat with your own NaN API key. No subscriptions, no account linking: paste a key, pick a model, chat.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://nan.builders/badge/built-with-nan-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://nan.builders/badge/built-with-nan-light.svg">
  <img alt="Built with NaN" src="https://nan.builders/badge/built-with-nan-light.svg" height="56">
</picture>

## What it does

- Registers the **`nan-builders`** language-model vendor inside VS Code's chat provider system.
- Streams chat completions token by token, including reasoning traces and tool calls, so agent mode works against NaN models.
- Keeps a **per-key slot queue** so parallel Copilot requests never exceed the gateway's parallel-request limit (429s stay rare instead of guaranteed).
- Two independent clocks per request: a **connect timeout** (headers must arrive) and an **idle timeout** that re-arms on every chunk — long agent turns are never killed by a total deadline.
- Hybrid model catalog: curated local metadata merged with the live `/models` directory, so brand-new NaN models appear without an extension update.
- Usage tracking per model in the status bar, with the gateway's own totals.

## Install

1. Grab the latest `.vsix` from [Releases](https://github.com/SrScorpio/nan-bridge/releases/latest).
2. In VS Code: Extensions → `…` → **Install from VSIX…**
3. Run **NaN Bridge: Set API Key** (create one at [NaN.Builders → API Keys](https://app.nan.builders/api-keys)).
4. In Copilot Chat's model picker, entries under the **NaN** vendor appear. Pick one and chat.

> The gateway allows a limited number of parallel requests **per key**. Using the same key in several editors multiplies pressure on that limit — prefer one key per client.

## Commands

| Command | What it does |
| --- | --- |
| `NaN Bridge: Set API Key` | Store the key for a profile (VS Code secret storage) |
| `NaN Bridge: Clear API Key` | Remove a profile's key |
| `NaN Bridge: Select Profile` | Switch the active profile (editor, bot, …) |
| `NaN Bridge: Test Connection` | List models through the gateway with the active key |
| `NaN Bridge: Refresh Models` | Drop the catalog cache and re-fetch |
| `NaN Bridge: Show Usage` | Per-model request/token counters |
| `NaN Bridge: Show Diagnostics` | Dump state into the output channel |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `nanBridge.apiBaseUrl` | `https://api.nan.builders/v1` | Gateway endpoint |
| `nanBridge.requestConnectTimeoutSeconds` | `20` | Wait for response headers |
| `nanBridge.streamIdleTimeoutSeconds` | `120` | Silence limit on an open stream |
| `nanBridge.showUsageStatus` | `true` | Status-bar usage item |

## Development

```bash
npm install
npm run check     # compile + 57 tests
npm run package   # produce the .vsix (packaged README has no images)
```

Architecture notes live in the source headers: `src/gateway` (transport, SSE, slots), `src/copilot` (message conversion, response projection, provider), `src/models` (catalog, efforts, cache), `src/usage` (tracker, views).

MIT licensed. This project is an independent rebuild that borrows its original MIT-licensed foundation from [grikomsn/openai-oauth-copilot-chat](https://github.com/grikomsn/openai-oauth-copilot-chat); see [NOTICE.md](NOTICE.md).

## Links

- [NaN.Builders](https://nan.builders/?ref=built-with-nan) — the gateway this extension talks to
- [Built with NaN program](https://nan.builders/docs/built-with-nan)
- [Report an issue](https://github.com/SrScorpio/nan-bridge/issues)
