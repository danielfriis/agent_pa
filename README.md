# agent_pa

Very simplified OpenClaw-style runtime shell that uses OpenCode as the actual agent.

## Why this shape

- OpenClaw provides the broader runtime concept (channels, orchestration, local-first operation): [openclaw/openclaw](https://github.com/openclaw/openclaw)
- OpenCode provides the agent engine and tools (sessions, messages, event stream, coding/web/shell tools): [anomalyco/opencode](https://github.com/anomalyco/opencode)

This project keeps the shell thin and delegates agent behavior to OpenCode over HTTP.

Core concepts in this project are workspace, skills, tools, memory, channels, and installation.

## Core Concepts (Product Slices)

### Workspace

- Purpose: the agent's file-working area for task execution.
- Boundaries: source files, generated files, and runtime working context only.
- Default path: `agent_workspace/`.
- Interfaces:
  - `GET /workspace` returns workspace path info (`workspaceDir`, `opencodeDirectory`).
  - `POST /workspace/download-link` returns a validated download URL for a workspace-relative file.
  - `GET /workspace/download?path=<relative-file-path>` downloads a workspace file as an attachment.
  - Terminal command: `/workspace`.

### Memory

- Purpose: persistent context and preferences that carry across sessions.
- Storage: `agent_state/memory/memory.md`.
- Includes layered persistent system prompt files from `agent_defaults/system/*.md` + `agent_state/system/*.md` (state overrides defaults by filename).
- Interfaces:
  - `GET /state/memory`
  - `POST /state/memory`
  - `GET /state/system`
  - `POST /state/system`
  - Terminal commands: `/memory`, `/remember TEXT`.

### Skills

- Purpose: reusable instruction bundles for repeatable task handling.
- Storage: layered `agent_defaults/skills/` + `agent_state/skills/` (state overrides defaults by name).
- Runtime sync target: `OPENCODE_DIRECTORY/.opencode/skills/`.
- Interfaces:
  - `GET /state/skills`
  - Terminal commands: `/skills`, `/skill-new NAME`.

### Tools

- Purpose: explicit side-effect interfaces callable by the agent.
- Storage: layered `agent_defaults/tools/` + `agent_state/tools/` (state overrides defaults by filename). Built-in managed tools are file-based and sourced from `agent_defaults/tools/`.
- Runtime sync target: `OPENCODE_DIRECTORY/.opencode/tools/`.
- Contract:
  - Success shape: `{ ok: true, ... }`
  - Failure shape: `{ ok: false, error: "..." }`.

### Channels

- Purpose: user-facing surfaces that reuse the same service contracts.
- Current channels:
  - HTTP API routes.
  - SMS inbound webhook route (`/channels/sms/inbound`) with provider adapter boundary (currently Twilio).
  - Terminal chat adapter.
- Shared service boundary: `src/agent-service.js`.

### Installation

- Purpose: reproducible local and remote setup.
- Local:
  - `npm run check`
  - `npm run start:server`
- Remote:
  - Initial setup: `./deploy/setup-server.sh`
  - Updates: `./deploy/update-server.sh`.

## What is implemented (v0)

- Minimal HTTP API:
  - `GET /health` - app + OpenCode health
  - `GET /sessions` - list sessions (OpenCode + local metadata)
  - `POST /sessions` - create session in OpenCode
  - `POST /sessions/:id/message` - send text message and return normalized message history
  - `GET /sessions/:id/messages` - list normalized messages
  - `GET /workspace` - show agent working directory paths
  - `POST /workspace/download-link` - build a validated download link for a workspace file (`{"path":"relative/file.ext"}`)
  - `GET /workspace/download?path=...` - download workspace file bytes as an attachment
  - `GET /state` - show agent state paths, memory preview, and skills
  - `GET /state/memory` - read memory file
  - `POST /state/memory` - append memory (`{"text":"..."}`)
  - `GET /state/system` - read effective system prompt (concatenated from `system/*.md`)
  - `POST /state/system` - set persistent system prompt (`{"systemPrompt":"..."}`)
  - `GET /state/skills` - list local skills
  - `GET /events` - proxy OpenCode global SSE stream
  - `POST /channels/sms/inbound` - SMS inbound webhook endpoint (provider selected by env, Twilio supported now)
- Agent runtime workspace folder (`agent_workspace/`) used as OpenCode working directory.
- Agent defaults folder (`agent_defaults/`) with tracked built-ins:
  - `system/*.md`
  - `skills/`
  - `tools/`
- Agent state folder (`agent_state/`) with local mutable state:
  - `memory/memory.md`
  - `system/*.md` (state overrides defaults by filename)
  - `skills/` (state overrides defaults by name)
  - `tools/` (state overrides defaults by filename)
  - `sessions/<sessionId>.json` for session metadata (one file per session)
- `agent_state/effective/skills/` is built from defaults+state and then synced to `OPENCODE_DIRECTORY/.opencode/skills/`.
- `agent_state/effective/tools/` is built from defaults+state and then synced to `OPENCODE_DIRECTORY/.opencode/tools/`.
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
- Do not store keys in `/Users/danielfriis/Code/agent_pa/agent_state/sessions/*.json` or commit them to source files.
- Production: use a secret manager and inject env vars at runtime (do not rely on checked-in files).

## Run

```bash
npm run check
npm run start:server
```

Default app URL: `http://127.0.0.1:8787`

By default this app assumes OpenCode server at `http://127.0.0.1:4096`.
`AUTOSTART_OPENCODE` defaults to `true`, so `npm start` will launch OpenCode automatically unless you set it to `false`.
`OPENCODE_ENABLE_EXA` defaults to `true` in `.env.example` and enables OpenCode-hosted web search when using non-OpenCode model providers.
`OPENCODE_REQUEST_TIMEOUT_MS` defaults to `0` (no timeout) to allow long-running upstream tasks; set a positive value (for example `180000`) to fail stalled requests fast.
For real model responses, set `OPENAI_API_KEY` in `.env`.
OpenCode directory defaults to `agent_workspace/` and can be overridden with `OPENCODE_DIRECTORY`.
Defaults directory is `agent_defaults/` (`AGENT_DEFAULTS_DIR` overrides). Mutable state directory is `agent_state/` (`AGENT_STATE_DIR` overrides).
Session metadata files default to `agent_state/sessions/` and can be overridden with `STORE_DIR`.
Per-session transcript logs are optional and disabled by default. Enable with
`SESSION_LOG_ENABLED=true`; logs are written as JSONL files under
`agent_state/session_logs/` by default (`SESSION_LOG_DIR` overrides).
`SESSION_LOG_MAX_CHARS` controls max chars per text field per entry (default `2000`).
`SESSION_LOG_INCLUDE_SYSTEM=true` includes the injected system prompt in each entry.
`APP_PUBLIC_BASE_URL` can be set to the public origin used by clients (for example `https://agent.example.com`); workspace download links use this when available.
API auth defaults to off. If `APP_API_TOKEN` is set, auth is enabled automatically unless
`APP_REQUIRE_AUTH=false`. Use `Authorization: Bearer <token>` or `x-api-key: <token>`.
`GET /health` remains public by default; set `APP_ALLOW_UNAUTHENTICATED_HEALTH=false` to protect it.
When SMS is enabled, `/channels/sms/inbound` can be kept public with
`SMS_ALLOW_UNAUTHENTICATED_INBOUND=true` and protected with provider signature verification.
`SMS_INCLUDE_SEQUENCE_LABELS=true` (default) prefixes multipart SMS replies with `[n/N]` labels so out-of-order delivery is still readable.
Set `SMS_REPLY_MESSAGE_DELAY_MS` (for example `250`) to send multipart replies one chunk at a time with small pacing delays (applies when `SMS_TWILIO_VALIDATE_SIGNATURE=true`).
Shared chat update commands are enabled by default and run `deploy/update-server.sh`.
Tune with `UPDATE_COMMAND_ENABLED`, `UPDATE_SCRIPT_PATH`, `UPDATE_STATUS_FILE`, `UPDATE_COMMAND_TIMEOUT_MS`, and
`UPDATE_COMMAND_MAX_OUTPUT_CHARS`.

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
- `/session-new [title]`
- `/model providerID/modelID`
- `/session`
- `/update [--branch NAME] [--remote NAME] [--skip-deps] [--skip-check]`
- `/update-status`
- `/workspace`
- `/memory`
- `/remember TEXT`
- `/skills`
- `/skill-new NAME`
- `/exit`

Shared chat commands (available in terminal chat, SMS inbound messages, and `POST /sessions/:id/message`):
- `/help`
- `/session`
- `/session-new [title]`
- `/update [--branch NAME] [--remote NAME] [--skip-deps] [--skip-check]`
- `/update-status`

`/update` starts `deploy/update-server.sh` in the background and returns immediately.
Use `/update-status` to inspect the active run or the last completed run output.

Memory is automatically injected as system context from `agent_state/memory/memory.md` for each prompt.
System prompt markdown files are layered from `agent_defaults/system/` then `agent_state/system/`, with state files overriding defaults by filename. `POST /state/system` writes to `agent_state/system/system-prompt.md`.
Runtime OpenCode extensions and copied skills/tools live under `OPENCODE_DIRECTORY/.opencode/`.
Project-level OpenCode permissions live in `opencode.json` (this repo explicitly allows `websearch`).

## Twilio SMS Setup

This project now has a provider-agnostic SMS channel service with a Twilio adapter.
The conversation mapping is number-agnostic: sessions are keyed by `(provider, accountSid, to, from)`,
so multiple Twilio numbers can use the same endpoint without hardcoded numbers.

1. Configure `.env`:

```bash
SMS_ENABLED=true
SMS_PROVIDER=twilio
SMS_INBOUND_PATH=/channels/sms/inbound
SMS_ALLOW_UNAUTHENTICATED_INBOUND=true
# Max chars per outbound SMS message. Longer assistant replies are split across multiple messages.
SMS_MAX_REPLY_CHARS=320
# Optional: prefix multipart SMS chunks with [1/N], [2/N], ... for visible ordering hints.
SMS_INCLUDE_SEQUENCE_LABELS=true
# Optional: when >0, send multipart replies via Twilio API with this delay between chunks (ms).
# Requires SMS_TWILIO_VALIDATE_SIGNATURE=true.
SMS_REPLY_MESSAGE_DELAY_MS=0
# Optional override. Keep the "tools and skills remain available" guidance unless intentionally changing behavior.
# SMS_DEFAULT_SYSTEM_PROMPT=You are replying to a user over SMS. Access to all tools and skills remains available; SMS only changes response formatting. Respond with plain text only and keep it concise.
# Optional canned reply for sender numbers that are not allowed.
# SMS_UNAUTHORIZED_REPLY=This phone number is not authorized to use this SMS channel.
SMS_TWILIO_AUTH_TOKEN=your_twilio_auth_token
SMS_TWILIO_VALIDATE_SIGNATURE=true
SMS_TWILIO_WEBHOOK_BASE_URL=https://your-public-host.example
# For IP-based HTTP deployments, use:
# SMS_TWILIO_WEBHOOK_BASE_URL=http://<server-ip>
```

2. Start the server:

```bash
npm run start:server
```

3. In Twilio Console for your phone number:
   - Go to **Phone Numbers -> Manage -> Active numbers -> your number**.
   - Under **Messaging**, set **A MESSAGE COMES IN** webhook to:
     `https://your-public-host.example/channels/sms/inbound`
   - Method: `POST`.
   - Keep it canonical without a trailing slash (`/channels/sms/inbound`).

4. Optional multi-account/BYO Twilio setup (for multiple account SIDs):

```bash
SMS_TWILIO_AUTH_TOKENS=ACxxxxxxxx:token1,ACyyyyyyyy:token2
# or
SMS_TWILIO_AUTH_TOKENS_JSON={"ACxxxxxxxx":"token1","ACyyyyyyyy":"token2"}
```

5. Optional destination allowlist (only accept inbound for selected Twilio numbers):

```bash
SMS_TWILIO_ALLOWED_TO_NUMBERS=+15551234567,+15557654321
```

6. Optional sender allowlist (only allow inbound from selected sender number(s); all others receive the canned unauthorized reply):

```bash
SMS_TWILIO_ALLOWED_FROM_NUMBERS=+15550001111
```

7. Optional per-session transcript logs for debugging all channels (API, terminal, SMS):

```bash
SESSION_LOG_ENABLED=true
# Optional overrides:
# SESSION_LOG_DIR=./agent_state/session_logs
# SESSION_LOG_MAX_CHARS=2000
# SESSION_LOG_INCLUDE_SYSTEM=false
```

Troubleshooting:
- If `POST http://127.0.0.1:8787/channels/sms/inbound` returns JSON `403` but public URL returns Nginx HTML `404`, Nginx site routing is misconfigured. See `/Users/danielfriis/Code/agent_pa/docs/remote-server-install.md`.
- When session transcript logging is enabled, inspect `SESSION_LOG_DIR/<sessionId>.jsonl` to compare `assistant_response` entries (raw assistant text at service level) with channel-specific delivery behavior.

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

Update an existing remote install:

```bash
cd agent_pa
./deploy/update-server.sh
```

Or via npm:

```bash
npm run deploy:update:server
```

The update script also refreshes Nginx site symlinks so `agent-pa.conf` stays enabled and the default site is disabled.

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
