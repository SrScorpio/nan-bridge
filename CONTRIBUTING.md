# Contributing to NaN Bridge

- Only NaN.Builders models and endpoints; no other providers in this codebase.
- Pure modules under `src/` (no `vscode` imports) must stay testable with `node --test`.
- All user-facing numbers use `en-US` formatting; never bare `toLocaleString()`.
- No runtime dependencies. `vsce` forbids SVGs in the packaged README — edit `README_PACKAGE.md` for package-facing copy.
- Run `npm run check` (compile + tests) and `npm run package` before pushing.
- Security reports go through the GitHub Security tab, not public issues.
