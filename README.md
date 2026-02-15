# agent_pa

Very simplified OpenClaw-style runtime shell that uses OpenCode as the actual agent.

## Why this shape

- OpenClaw provides the broader runtime concept (channels, orchestration, local-first operation): [openclaw/openclaw](https://github.com/openclaw/openclaw)
- OpenCode provides the agent engine and tools (sessions, messages, event stream, coding/web/shell tools): [anomalyco/opencode](https://github.com/anomalyco/opencode)

This project keeps the shell thin and delegates agent behavior to OpenCode over HTTP.

Core concepts in this project are workspace, skills, tools, memory, channels, and installation.

## What is implemented (v0)

- Minimal HTTP API:
  - `GET /health` - app + OpenCode health
  - `GET /sessions` - list sessions (OpenCode + local metadata)
  - `POST /sessions` - create session in OpenCode
  - `POST /sessions/:id/message` - send text message and return normalized message history
  - `GET /sessions/:id/messages` - list normalized messages
  - `GET /workspace` - show workspace paths, memory preview, and skills
  - `GET /workspace/memory` - read memory file
  - `POST /workspace/memory` - append memory (`{"text":"..."}`)
  - `GET /workspace/system` - read effective system prompt (concatenated from `system/*.md`)
  - `POST /workspace/system` - set persistent system prompt (`{"systemPrompt":"..."}`)
  - `GET /workspace/skills` - list local skills
  - `GET /events` - proxy OpenCode global SSE stream
- Agent runtime workspace folder (`agent_workspace/`) used as OpenCode working directory.
- Agent config folder (`agent_config/`) with:
  - `memory/memory.md`
  - `system/*.md` (all markdown files are loaded in filename order)
  - `skills/` (copied to OpenCode as-is)
  - `tools/` (copied to OpenCode as-is, including managed tool definitions)
  - `sessions/<sessionId>.json` for session metadata (one file per session)
- `agent_config/skills/` is copied to `OPENCODE_DIRECTORY/.opencode/skills/` on startup and after `/skill-new`.
- `agent_config/tools/` is copied to `OPENCODE_DIRECTORY/.opencode/tools/` on startup.
- Tool contract convention: each tool should return structured JSON with
  `ok: true` on success, or `ok: false` with an `error` field on failure.
- Optional OpenCode autostart (`opencode serve`) controlled by env vars.
- Terminal chat mode (TTY): starts a fresh OpenCode session on boot and lets you chat directly in the same terminal.
- Channel-ready agent service layer (`src/agent-service.js`) used by the terminal adapter, so additional channels can reuse the same session/message contract.

## Prerequisites

- Node.js 20+
- OpenCode CLI (`opencode`) available either globally or via local dependency

## Secrets / API keys

- Local development: persist keys in `/Users/danielfriis/Code/agent_pa/.env` (gitignored), for example `OPENAI_API_KEY=...`.
- Do not store keys in `/Users/danielfriis/Code/agent_pa/agent_config/sessions/*.json` or commit them to source files.
- Production: use a secret manager and inject env vars at runtime (do not rely on checked-in files).

## Run

```bash
npm run check
npm run start:server
```

Default app URL: `http://127.0.0.1:8787`

By default this app assumes OpenCode server at `http://127.0.0.1:4096`.
`AUTOSTART_OPENCODE` defaults to `true`, so `npm start` will launch OpenCode automatically unless you set it to `false`.
For real model responses, set `OPENAI_API_KEY` in `.env`.
OpenCode directory defaults to `agent_workspace/` and can be overridden with `OPENCODE_DIRECTORY`.
Session metadata files default to `agent_config/sessions/` and can be overridden with `STORE_DIR`.
API auth defaults to off. If `APP_API_TOKEN` is set, auth is enabled automatically unless
`APP_REQUIRE_AUTH=false`. Use `Authorization: Bearer <token>` or `x-api-key: <token>`.
`GET /health` remains public by default; set `APP_ALLOW_UNAUTHENTICATED_HEALTH=false` to protect it.

Start modes:
- `npm run start:server` starts only the HTTP server so channel clients can connect.
- `npm run start:terminal` starts the HTTP server and the terminal chat channel client in the same process.

### Terminal chat behavior

When started with `npm run start:terminal`:
- Creates a new session automatically
- Prompts with `you> `
- Returns assistant output inline

Commands:
- `/help`
- `/new [title]`
- `/model providerID/modelID`
- `/session`
- `/workspace`
- `/memory`
- `/remember TEXT`
- `/skills`
- `/skill-new NAME`
- `/exit`

Memory is automatically injected as system context from `agent_config/memory/memory.md` for each prompt.
All markdown files in `agent_config/system/` are loaded in filename order and prepended to each prompt. `POST /workspace/system` writes to `agent_config/system/system-prompt.md`.
Runtime OpenCode extensions and copied skills/tools live under `OPENCODE_DIRECTORY/.opencode/`.

## Remote deployment

Use the Linux install guide:
- `/Users/danielfriis/Code/agent_pa/docs/remote-server-install.md`

Fast path:

```bash
git clone <your-repo-url>
cd agent_pa
./deploy/setup-server.sh
```

The script installs dependencies, writes `.env`, generates `APP_API_TOKEN`,
sets up `systemd` + Nginx, and starts services.

Included templates:
- `/Users/danielfriis/Code/agent_pa/deploy/systemd/agent-pa.service.example`
- `/Users/danielfriis/Code/agent_pa/deploy/nginx/agent-pa.conf.example`

## Quick API smoke

```bash
curl -s http://127.0.0.1:8787/health | jq

SESSION_ID=$(curl -s -X POST http://127.0.0.1:8787/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"Demo"}' | jq -r '.session.id')

curl -s -X POST "http://127.0.0.1:8787/sessions/$SESSION_ID/message" \
  -H 'content-type: application/json' \
  -d '{"text":"Build a tiny TODO CLI in Python."}' | jq
```

## Next upgrades

1. Add HTML/web channel adapter reusing the shared agent service.
2. Add channel adapters (Telegram/Slack/Discord) that map directly onto session IDs.
3. Add job queue + retry around outbound messages.
4. Add per-workspace guardrails (tool allowlists, budgets, execution caps).
5. Add API rate limiting and audit logs for remote deployments.
