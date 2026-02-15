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

## Result

After setup, service is reachable at:

- `http://<server-ip>/health`
- `http://<server-ip>/sessions` (requires `Authorization: Bearer <token>`)

The script prints the generated `APP_API_TOKEN` at the end.

## TLS (recommended)

The setup script configures HTTP only. Add TLS with Certbot:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <your-domain>
```
