#!/usr/bin/env bash
set -euo pipefail

APP_NAME="agent-pa"
SERVICE_NAME="agent-pa"
APP_PORT="${APP_PORT:-8787}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
SERVER_NAME="${SERVER_NAME:-_}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_DIR}/.env"
SYSTEMD_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
NGINX_SITE_PATH="/etc/nginx/sites-available/${APP_NAME}.conf"
NGINX_ENABLED_PATH="/etc/nginx/sites-enabled/${APP_NAME}.conf"
NGINX_DEFAULT_ENABLED_PATH="/etc/nginx/sites-enabled/default"

OPENAI_API_KEY_INPUT="${OPENAI_API_KEY:-}"
APP_API_TOKEN_INPUT="${APP_API_TOKEN:-}"

usage() {
  cat <<'EOF'
Usage: ./deploy/setup-server.sh [options]

Options:
  --openai-api-key <key>  Set OPENAI_API_KEY non-interactively.
  --server-name <name>    Nginx server_name (default: _).
  --app-port <port>       agent_pa HTTP port behind Nginx (default: 8787).
  --opencode-port <port>  OpenCode port (default: 4096).
  --help                  Show this help.
EOF
}

log() {
  printf '[setup] %s\n' "$1"
}

fail() {
  printf '[setup] ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --openai-api-key)
        [[ $# -ge 2 ]] || fail "Missing value for --openai-api-key"
        OPENAI_API_KEY_INPUT="$2"
        shift 2
        ;;
      --server-name)
        [[ $# -ge 2 ]] || fail "Missing value for --server-name"
        SERVER_NAME="$2"
        shift 2
        ;;
      --app-port)
        [[ $# -ge 2 ]] || fail "Missing value for --app-port"
        APP_PORT="$2"
        shift 2
        ;;
      --opencode-port)
        [[ $# -ge 2 ]] || fail "Missing value for --opencode-port"
        OPENCODE_PORT="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
  done
}

ensure_sudo() {
  require_cmd sudo
  sudo -v
}

ensure_apt() {
  require_cmd apt-get
}

install_system_packages() {
  log "Installing OS packages (curl, ca-certificates, gnupg, nginx)"
  sudo apt-get update
  sudo apt-get install -y curl ca-certificates gnupg nginx
}

ensure_node_20() {
  local need_install="false"
  if ! command -v node >/dev/null 2>&1; then
    need_install="true"
  else
    local major
    major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
    if [[ "${major}" -lt 20 ]]; then
      need_install="true"
    fi
  fi

  if [[ "${need_install}" == "true" ]]; then
    log "Installing Node.js 20.x via NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
}

prompt_openai_api_key() {
  if [[ -n "${OPENAI_API_KEY_INPUT}" ]]; then
    return
  fi

  if [[ -t 0 ]]; then
    while [[ -z "${OPENAI_API_KEY_INPUT}" ]]; do
      read -r -s -p "Enter OPENAI_API_KEY: " OPENAI_API_KEY_INPUT
      printf '\n'
    done
    return
  fi

  fail "OPENAI_API_KEY is required. Provide --openai-api-key or OPENAI_API_KEY env var."
}

generate_auth_token() {
  if [[ -n "${APP_API_TOKEN_INPUT}" ]]; then
    return
  fi
  require_cmd openssl
  APP_API_TOKEN_INPUT="$(openssl rand -hex 32)"
}

upsert_env() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "${value}" | sed 's/[\/&]/\\&/g')"

  if grep -qE "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    sed -i "s/^${key}=.*/${key}=${escaped}/" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

write_env_file() {
  log "Writing ${ENV_FILE}"
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  upsert_env "APP_HOST" "127.0.0.1"
  upsert_env "APP_PORT" "${APP_PORT}"
  upsert_env "TERMINAL_CHAT" "false"

  upsert_env "AGENT_WORKSPACE_DIR" "${REPO_DIR}/agent_workspace"
  upsert_env "AGENT_CONFIG_DIR" "${REPO_DIR}/agent_config"
  upsert_env "STORE_DIR" "${REPO_DIR}/agent_config/sessions"
  upsert_env "SESSION_LOG_ENABLED" "false"
  upsert_env "SESSION_LOG_DIR" "${REPO_DIR}/agent_config/session_logs"
  upsert_env "SESSION_LOG_MAX_CHARS" "2000"
  upsert_env "SESSION_LOG_INCLUDE_SYSTEM" "false"

  upsert_env "OPENCODE_SERVER_URL" "http://127.0.0.1:${OPENCODE_PORT}"
  upsert_env "OPENCODE_SERVER_HOST" "127.0.0.1"
  upsert_env "OPENCODE_SERVER_PORT" "${OPENCODE_PORT}"
  upsert_env "OPENCODE_DIRECTORY" "${REPO_DIR}/agent_workspace"
  upsert_env "OPENCODE_REQUEST_TIMEOUT_MS" "0"
  upsert_env "AUTOSTART_OPENCODE" "true"
  upsert_env "OPENCODE_ENABLE_EXA" "true"

  upsert_env "APP_REQUIRE_AUTH" "true"
  upsert_env "APP_API_TOKEN" "${APP_API_TOKEN_INPUT}"
  upsert_env "APP_ALLOW_UNAUTHENTICATED_HEALTH" "true"

  upsert_env "OPENAI_API_KEY" "${OPENAI_API_KEY_INPUT}"
}

install_node_dependencies() {
  log "Installing Node.js dependencies"
  (cd "${REPO_DIR}" && npm ci --omit=dev)
}

write_systemd_unit() {
  local run_user
  run_user="${SUDO_USER:-$USER}"
  local npm_path
  npm_path="$(command -v npm)"

  log "Writing ${SYSTEMD_UNIT_PATH}"
  sudo tee "${SYSTEMD_UNIT_PATH}" >/dev/null <<EOF
[Unit]
Description=agent_pa runtime service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${run_user}
WorkingDirectory=${REPO_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${ENV_FILE}
ExecStart=${npm_path} run start:server
Restart=always
RestartSec=5
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF
}

write_nginx_config() {
  log "Writing ${NGINX_SITE_PATH}"
  sudo tee "${NGINX_SITE_PATH}" >/dev/null <<EOF
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name ${SERVER_NAME};

  client_max_body_size 10m;

  location / {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    proxy_set_header Authorization \$http_authorization;
    proxy_connect_timeout 75s;
    proxy_send_timeout 86400s;
    proxy_read_timeout 86400s;
    send_timeout 86400s;
    proxy_pass http://127.0.0.1:${APP_PORT};
  }
}
EOF

  sudo ln -sfn "${NGINX_SITE_PATH}" "${NGINX_ENABLED_PATH}"
  sudo rm -f "${NGINX_DEFAULT_ENABLED_PATH}"
}

enable_services() {
  log "Validating and reloading Nginx"
  sudo nginx -t
  sudo systemctl enable --now nginx
  sudo systemctl reload nginx

  log "Enabling ${SERVICE_NAME} service"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "${SERVICE_NAME}"
  sudo systemctl restart "${SERVICE_NAME}"
}

print_summary() {
  cat <<EOF

Setup complete.

Service:
  sudo systemctl status ${SERVICE_NAME}
  journalctl -u ${SERVICE_NAME} -f

URLs:
  http://<server-ip>/health
  http://<server-ip>/sessions   (requires auth token)

Auth token (store this securely):
  ${APP_API_TOKEN_INPUT}

Example API call:
  curl -s http://<server-ip>/sessions -H "Authorization: Bearer ${APP_API_TOKEN_INPUT}"
EOF
}

main() {
  parse_args "$@"
  ensure_sudo
  ensure_apt
  install_system_packages
  ensure_node_20
  prompt_openai_api_key
  generate_auth_token
  install_node_dependencies
  write_env_file
  write_systemd_unit
  write_nginx_config
  enable_services
  print_summary
}

main "$@"
