# AGENTS.md

## Project Overview

This project is an agent for people to complete many different tasks. Each agent operates inside a workspace and has access to tools, memory, and skills.

## Core Concepts

- Workspace: the operating directory and local state boundary where the agent reads, writes, and executes.
- Skills: reusable instruction bundles that guide how the agent handles specific task types.
- Tools: explicit integrations and side-effect interfaces the agent can call.
- Memory: persisted context/preferences used to keep behavior consistent over time.
- Channels: user interaction surfaces that connect to the same agent service contract. Current channel is terminal chat; future channels should plug in without changing core agent logic.
- Installation: the reproducible setup path that provisions dependencies, configuration, security defaults, and service wiring for local and remote environments.

## Scope

- Node.js 20+, ESM modules.
- HTTP + terminal agent runtime with a swappable brain integration (currently OpenCode).

## Architecture

1. Productize and modularize each core capability as its own component with explicit contracts: brain integration, workspace, tools, skills, memory, installation, and transport/channel layers.
2. Keep the brain integration behind a stable adapter boundary so OpenCode can be replaced later without rewriting the whole system.
3. Keep modules small, focused, and composable.
4. Keep `src/server.js` as startup wiring only.
5. Keep boundaries explicit:
   - Routes: request/response + validation.
   - Services: orchestration and business flow.
   - Utilities: shared stateless helpers.
6. Split files only for clear boundary or reuse value.
7. Treat architecture as a top priority; always assess architectural impact before implementing.
8. After implementation, review the result against the architecture and refine it if needed.

## Contracts

1. Side effects must use explicit interfaces (tools/APIs/events), never free-text contracts.
2. Tool results must be structured:
   - Success: `{ ok: true, ... }`
   - Failure: `{ ok: false, error: "..." }`
3. Do not use heuristic post-response detection for side effects.
4. Prefer stable response shapes.
5. Sync functions should return `{ syncedCount, removedCount, sourceDir, targetDir }` when applicable.

## Code Quality

1. Prefer simple designs, clear naming, and DRY shared helpers.
2. Follow dependency docs and idiomatic patterns.
3. During refactors/reorgs, update imports/scripts/tests/docs in the same change.
4. Remove stale files and references after reorganizing.
5. Build-out phase: migrations are optional; keep data structures easy to revise.

## Testing and Operations

1. Add or update tests for behavior changes; include regression tests for bug fixes when practical.
2. Run `npm run check` after cleanup/refactor work and before finalizing substantial changes.
3. If behavior diverges unexpectedly, restart the OpenCode daemon before deeper debugging.

## Security and Documentation

1. Never commit secrets; use environment variables and keep secrets out of logs/sessions.
2. Validate external input at route boundaries and return clear, structured errors.
3. Keep README and operational docs aligned with behavior.
4. When a stable preference is learned, update this file with a general rule (not a one-off).

## Lessons Log

1. Keep a root-level file named `LESSONS.md`.
2. Every time the coding agent makes a technical assumption (implementation, behavior, tooling, or debugging) that turns out to be wrong, append a new entry to `LESSONS.md` in the same change.
3. Do not log non-technical preference corrections (tone, naming style, or wording preferences) in `LESSONS.md`.
4. Each entry should include:
   - Date
   - Incorrect assumption
   - What was actually true
   - Adjustment to prevent the same mistake
