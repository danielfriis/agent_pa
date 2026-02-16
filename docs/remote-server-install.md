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
5. Creates and starts `systemd` service `agent-pa`.
6. Writes and reloads Nginx proxy config.

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
5. Verifies `/health` on localhost.

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

## TLS (recommended)

The setup script configures HTTP only. Add TLS with Certbot:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <your-domain>
```
