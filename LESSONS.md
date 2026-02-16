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
