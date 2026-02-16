# Remote Server Install (Clone + Setup Script)

This project now supports a one-script Ubuntu setup for remote access.

## Fast path

```bash
git clone <your-repo-url>
cd agent_pa
./deploy/setup-server.sh
```

The script prompts only for `OPENAI_API_KEY` (unless you pass it in).
It automatically:

1. Installs system packages (`nginx`, Node.js 20 if needed).
2. Installs app dependencies (`npm ci --omit=dev`).
3. Generates a random API auth token.
4. Writes `.env` with remote-safe defaults and auth enabled.
   - Includes `OPENCODE_ENABLE_EXA=true` so OpenCode web search is enabled with non-OpenCode providers.
   - Sets `OPENCODE_REQUEST_TIMEOUT_MS=0` so long-running tasks are not cut off by app-level timeouts.
5. Creates and starts `systemd` service `agent-pa`.
6. Writes and reloads Nginx proxy config.
   - Includes long proxy timeouts (`proxy_read_timeout`/`proxy_send_timeout` set to 86400s).
7. Disables the default Nginx site symlink to avoid route conflicts.

## Non-interactive mode

```bash
OPENAI_API_KEY="<your-openai-key>" ./deploy/setup-server.sh
```

Or:

```bash
./deploy/setup-server.sh --openai-api-key "<your-openai-key>"
```

Optional flags:

```bash
./deploy/setup-server.sh --server-name agent.example.com --app-port 8787 --opencode-port 4096
```

## Updating after install

When the server is already installed and you want the latest code/dependencies:

```bash
cd agent_pa
./deploy/update-server.sh
```

What this does:

1. Pulls the latest git changes with `--ff-only`.
2. Reinstalls production dependencies (`npm ci --omit=dev`).
3. Runs `npm run check:syntax`.
4. Restarts `agent-pa` with systemd.
5. Refreshes Nginx site symlinks (`agent-pa.conf` enabled, default site disabled).
6. Verifies `/health` on localhost.

Useful options:

```bash
./deploy/update-server.sh --branch main
./deploy/update-server.sh --skip-check
./deploy/update-server.sh --skip-deps
```

## Result

After setup, service is reachable at:

- `http://<server-ip>:80/health`
- `http://<server-ip>:80/sessions` (requires `Authorization: Bearer <token>`)

Routing note:
- External traffic goes to Nginx on port `80`.
- Nginx proxies to the app on `127.0.0.1:8787` (or your `--app-port` value).
- `https://` is not enabled by default; configure TLS first.

The script prints the generated `APP_API_TOKEN` at the end.

## SMS webhook routing check

If Twilio reports an Nginx `404` page while localhost works:

1. Verify app route is reachable directly:

```bash
curl -i -X POST http://127.0.0.1:8787/channels/sms/inbound \
  -d 'From=%2B15550001111&To=%2B15559998888&Body=test'
```

Expected with signature validation enabled: `403` with JSON error about missing signature.

2. Verify Nginx forwards to app:

```bash
curl -i -X POST http://127.0.0.1/channels/sms/inbound \
  -d 'From=%2B15550001111&To=%2B15559998888&Body=test'
```

If this returns Nginx HTML `404`, check enabled site symlinks and reload:

```bash
sudo ls -l /etc/nginx/sites-enabled
sudo nginx -t && sudo systemctl reload nginx
```

## TLS (recommended)

The setup script configures HTTP only. Add TLS with Certbot:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <your-domain>
```
