# LESSONS

Use this file to log incorrect assumptions made by the coding agent.

## Entry Template

- Date: YYYY-MM-DD
- Incorrect assumption:
- What was actually true:
- Adjustment to prevent recurrence:

## 2026-02-16

- Date: 2026-02-16
- Incorrect assumption: A Twilio webhook `404` likely meant the app route or SMS feature flags were incorrect.
- What was actually true: The app route was healthy (`127.0.0.1:8787/channels/sms/inbound` responded), but public traffic hit an Nginx server block/site-symlink mismatch and returned an Nginx HTML `404` before proxying.
- Adjustment to prevent recurrence: During webhook debugging, first test localhost app endpoint and localhost Nginx endpoint separately, then inspect `/etc/nginx/sites-enabled` and enforce `agent-pa.conf` enabled + `default` disabled in setup/update scripts.

- Date: 2026-02-16
- Incorrect assumption: A manual `curl` `403` on SMS inbound indicated a broken inbound route.
- What was actually true: `403` with `Missing x-twilio-signature` is expected when Twilio signature validation is enabled and the request is not from Twilio.
- Adjustment to prevent recurrence: Treat this `403` as a positive routing signal; use it as a diagnostic checkpoint before investigating token/base-URL signature mismatch.

- Date: 2026-02-16
- Incorrect assumption: SMS webhook path handling should require an exact configured path string.
- What was actually true: Operationally, trailing-slash variations can occur and should not break routing/auth-bypass logic.
- Adjustment to prevent recurrence: Normalize configured and incoming route paths (trim trailing slash, enforce leading slash) in both route matching and config parsing, with regression tests.

- Date: 2026-02-16
- Incorrect assumption: Post-deploy SMS fallback replies were primarily due to transient OpenCode startup timing.
- What was actually true: A malformed JSON file in the local session store caused `SessionStore.listSessions()` to throw, which triggered the SMS fallback path.
- Adjustment to prevent recurrence: Treat persistent fallback replies as a data-integrity signal first; log the caught exception and harden file-backed stores to quarantine invalid records instead of failing request handling.

- Date: 2026-02-16
- Incorrect assumption: Node tests could bind a local HTTP server in this execution sandbox.
- What was actually true: The test environment denied `listen(127.0.0.1)` with `EPERM`, so socket-based tests failed regardless of code correctness.
- Adjustment to prevent recurrence: Prefer mocking `fetch` directly for HTTP client behavior tests in constrained environments, and avoid listener-based tests unless socket permissions are confirmed.

- Date: 2026-02-16
- Incorrect assumption: `opencode debug config` would run reliably inside this sandboxed environment for local introspection.
- What was actually true: The command failed with `EPERM` while initializing OpenCode logging in the sandbox, so it was not a dependable way to inspect runtime settings here.
- Adjustment to prevent recurrence: Use project config files (`opencode.json`, `.env`, synced tool files) as the primary inspection source in sandboxed runs, and only use OpenCode debug commands when unrestricted execution is available.

- Date: 2026-02-16
- Incorrect assumption: Returning `provider.formatReply([])` would produce an empty TwiML response with no outbound message side effects.
- What was actually true: The formatter emitted `<Message></Message>` for empty input, which represented a blank message node instead of a truly empty response.
- Adjustment to prevent recurrence: For no-op webhook acknowledgements, explicitly render `<Response></Response>` and add tests that assert empty-message behavior for provider formatters.

- Date: 2026-02-16
- Incorrect assumption: Keeping update command status only in memory was sufficient for `/update-status`.
- What was actually true: Running updates can restart the service process, which clears in-memory state and makes `/update-status` incorrectly report that no update ran.
- Adjustment to prevent recurrence: Persist update run state to disk and reload it on startup, converting any previously-running state into an explicit interrupted result.

- Date: 2026-02-16
- Incorrect assumption: A persisted `running` update state after startup should be reported as a failed interruption.
- What was actually true: For in-chat updates, a service restart is expected and usually indicates handoff, not a deterministic script failure; reporting hard failure was misleading.
- Adjustment to prevent recurrence: Classify recovered `running` states as a restart handoff status with explicit guidance, and reserve failed status for confirmed non-zero/timeout/error exits observed by the runner.

## 2026-02-17

- Date: 2026-02-17
- Incorrect assumption: The route handler config object always includes `config.app` when building absolute URLs.
- What was actually true: Route tests and some injected configs can omit `config.app`, causing undefined host/port access and a `500` response.
- Adjustment to prevent recurrence: Treat optional config slices defensively in route modules and provide explicit host/port fallbacks when building URLs.

## 2026-02-18

- Date: 2026-02-18
- Incorrect assumption: Adding managed tools by embedding full source code as large inline template strings in sync/orchestration modules was an acceptable long-term structure.
- What was actually true: Inline source blobs obscured architecture boundaries and made maintenance/refactoring harder than keeping built-ins as first-class files.
- Adjustment to prevent recurrence: Keep built-in tools/skills/system prompts as file-based defaults in a dedicated defaults directory, and keep sync modules focused on layering/copying instead of carrying embedded code content.

- Date: 2026-02-18
- Incorrect assumption: Test setup could create directories and write nested files in the same `Promise.all` batch without ordering guarantees.
- What was actually true: Parallel writes to nested paths failed with `ENOENT` when directory creation had not completed first.
- Adjustment to prevent recurrence: Create prerequisite directories before concurrent write batches, or sequence dependent file operations explicitly in tests.
