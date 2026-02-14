# AGENTS.md

## Engineering Directives

1. Organize the codebase into small, focused, composable modules with clear boundaries.
2. Keep naming clear, consistent, and logical across files, modules, functions, and variables.
3. Think of the overall system as a set of products/components (`tools`, `skills`, `memory`, workflows, etc.) with explicit contracts so each part can evolve and scale independently.
4. Before writing code that uses dependencies, check their documentation and prefer idiomatic patterns.
5. Keep the codebase DRY by extracting shared behavior into reusable modules, functions, or utilities.
6. We are currently in a build-out phase, so migrations are not required right now. This is temporary and should stay easy to revise later.
7. After reorganizations, clean up legacy files, directories, and stale references so old and new structures do not coexist unintentionally.
8. Keep naming symmetrical across related modules. For sync modules, use consistent pairs like `skill-sync.js` and `tool-sync.js`, with matching verb patterns in exported function names.
9. Prefer uniform sync contracts. Sync functions should return the same shape when possible: `{ syncedCount, removedCount, sourceDir, targetDir }`.
10. Keep entrypoints thin. `server.js` should stay a minimal startup wrapper; routing, chat flow, and bootstrapping belong in dedicated modules.
11. Extract shared helpers (for example path normalization) into utility modules instead of duplicating logic across files.
12. When renaming or reorganizing, update all imports, scripts, and docs in the same change so old and new naming does not coexist.
13. Never use unstructured free text as an execution contract for side effects; side effects must go through explicit, typed interfaces (commands, APIs, events, or tool contracts).
14. Standardize tool result contracts: tools should return structured JSON with `ok: true` on success or `ok: false` with an `error` message on failure.
15. Do not add heuristic post-response detection to infer whether side effects happened; rely on explicit tool result contracts and propagate those results directly.
16. After cleanup/refactor work, run the project checks (`npm run check`) before finalizing.
17. If runtime behavior suddenly diverges from recent code changes (for example schema errors, missing capabilities, or stale responses), treat a stale OpenCode daemon as a common cause and fully restart it before deeper debugging.
