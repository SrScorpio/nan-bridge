# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-11-13

Credit-based billing. NaN now charges a **credit pool per billing period**
instead of monthly token allowances, and its `/usage` report exposes the
numbers, so the panel shows what the gateway actually bills.

### Added

- **Credits in the usage panel**: status bar leads with `used/allowance`
  credits, and the tooltip/quick pick show the billing period, credits
  spent and remaining, and pack credits with their expiry date.
- **Per-model credit spend** for the window and the current calendar
  month, alongside tokens.
- **Inactive-subscription warning** when the gateway reports
  `credits.frozen` — credit-billed requests are refused until it clears.
- Window figures now come from the report's `totals` object (guaranteed to
  cover the whole window even when rows are paginated), with row sums as a
  fallback.

### Changed

- Documented **token allowances removed** from the catalog: quotas were a
  token-era concept and are superseded by real credit balances.
- README/settings docs corrected (`nanBridge.showUsageStatusBar`, missing
  `nanBridge.reasoningEffort`, test count).

### Fixed

- Credit sums are rounded to one decimal, so float noise from the wire
  never leaks into the panel.

## [1.0.0] — 2026-11-10

Initial public release.

### Added

- **`nan-builders` language-model vendor** inside VS Code's chat provider
  system: bring [NaN.Builders](https://nan.builders) open models — GLM,
  Qwen, DeepSeek, Gemma and more — into GitHub Copilot Chat with your own
  API key. No subscriptions, no account linking.
- Streaming chat completions with reasoning traces and tool calls, so
  agent mode works against NaN models.
- **Per-key slot queue** so parallel Copilot requests never exceed the
  gateway's per-key parallel-request limit.
- Two independent clocks per request: a **connect timeout** (headers must
  arrive) and an **idle timeout** that re-arms on every chunk — long agent
  turns are never killed by a total deadline.
- **Hybrid model catalog**: curated local metadata merged with the live
  `/models` directory, so brand-new NaN models appear without an extension
  update. Per-model reasoning-effort and context-window pickers.
- **Multi-profile keys** with per-model-id profile routing
  (`profile::model`): several NaN keys coexist, and each turn bills the
  key that owns the selected model.
- **Usage tracking from the gateway's own report**: 30-day window totals
  plus the current calendar month, with each model's documented monthly
  allowance shown as a percentage (quota-less models show plain usage).
  Follows `/usage` pagination so month aggregates stay complete.
- Commands: set/clear API key (VS Code secret storage), select profile,
  test connection, pick model, show usage.
- 93 unit tests, adversarial stream tests, and an end-to-end probe
  (tool call round-trip against the real gateway) backing the release.
