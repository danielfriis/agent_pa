#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-agent-pa}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH_INPUT=""
SKIP_DEPS="false"
SKIP_CHECK="false"
APP_NAME="${APP_NAME:-agent-pa}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_DIR}/.env"
NGINX_SITE_PATH="/etc/nginx/sites-available/${APP_NAME}.conf"
NGINX_ENABLED_PATH="/etc/nginx/sites-enabled/${APP_NAME}.conf"
NGINX_DEFAULT_ENABLED_PATH="/etc/nginx/sites-enabled/default"

usage() {
  cat <<'EOF'
Usage: ./deploy/update-server.sh [options]

Options:
  --branch <name>   Git branch to update (default: current branch).
  --remote <name>   Git remote to pull from (default: origin).
  --skip-deps       Skip npm dependency reinstall.
  --skip-check      Skip npm syntax check.
  --help            Show this help.
EOF
}

log() {
  printf '[update] %s\n' "$1"
}

fail() {
  printf '[update] ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --branch)
        [[ $# -ge 2 ]] || fail "Missing value for --branch"
        BRANCH_INPUT="$2"
        shift 2
        ;;
      --remote)
        [[ $# -ge 2 ]] || fail "Missing value for --remote"
        REMOTE_NAME="$2"
        shift 2
        ;;
      --skip-deps)
        SKIP_DEPS="true"
        shift
        ;;
      --skip-check)
        SKIP_CHECK="true"
        shift
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

ensure_repo() {
  git -C "${REPO_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    fail "Repository not found at ${REPO_DIR}"
}

ensure_clean_worktree() {
  if [[ -n "$(git -C "${REPO_DIR}" status --porcelain --untracked-files=no)" ]]; then
    fail "Tracked files have local changes. Commit or stash them before updating."
  fi
}

resolve_branch() {
  if [[ -n "${BRANCH_INPUT}" ]]; then
    printf '%s' "${BRANCH_INPUT}"
    return
  fi

  local current_branch
  current_branch="$(git -C "${REPO_DIR}" rev-parse --abbrev-ref HEAD)"
  [[ "${current_branch}" != "HEAD" ]] || fail "Detached HEAD detected. Pass --branch <name>."
  printf '%s' "${current_branch}"
}

read_env_var() {
  local key="$1"
  if [[ ! -f "${ENV_FILE}" ]]; then
    return
  fi
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 | cut -d= -f2- || true
}

update_code() {
  local branch="$1"
  local current_branch
  local before_sha
  local after_sha

  current_branch="$(git -C "${REPO_DIR}" rev-parse --abbrev-ref HEAD)"
  if [[ "${current_branch}" != "${branch}" ]]; then
    log "Switching branch from ${current_branch} to ${branch}"
    git -C "${REPO_DIR}" checkout "${branch}"
  fi

  before_sha="$(git -C "${REPO_DIR}" rev-parse --short HEAD)"
  log "Fetching latest refs from ${REMOTE_NAME}"
  git -C "${REPO_DIR}" fetch --prune "${REMOTE_NAME}"
  log "Pulling ${REMOTE_NAME}/${branch} with --ff-only"
  git -C "${REPO_DIR}" pull --ff-only "${REMOTE_NAME}" "${branch}"
  after_sha="$(git -C "${REPO_DIR}" rev-parse --short HEAD)"
  log "Revision: ${before_sha} -> ${after_sha}"
}

install_dependencies() {
  if [[ "${SKIP_DEPS}" == "true" ]]; then
    log "Skipping dependency reinstall (--skip-deps)"
    return
  fi

  log "Installing production dependencies"
  (cd "${REPO_DIR}" && npm ci --omit=dev)
}

run_checks() {
  if [[ "${SKIP_CHECK}" == "true" ]]; then
    log "Skipping syntax check (--skip-check)"
    return
  fi

  log "Running syntax check"
  (cd "${REPO_DIR}" && npm run check:syntax)
}

restart_service() {
  log "Reloading systemd and restarting ${SERVICE_NAME}"
  sudo systemctl daemon-reload
  sudo systemctl restart "${SERVICE_NAME}"
  sudo systemctl is-active --quiet "${SERVICE_NAME}" ||
    fail "Service ${SERVICE_NAME} is not active after restart."
  sudo systemctl --no-pager --lines=12 status "${SERVICE_NAME}"
}

refresh_nginx() {
  if ! command -v nginx >/dev/null 2>&1; then
    log "Skipping Nginx refresh (nginx command not found)"
    return
  fi

  if [[ ! -f "${NGINX_SITE_PATH}" ]]; then
    log "Skipping Nginx refresh (${NGINX_SITE_PATH} not found)"
    return
  fi

  log "Refreshing Nginx site symlinks"
  sudo ln -sfn "${NGINX_SITE_PATH}" "${NGINX_ENABLED_PATH}"
  sudo rm -f "${NGINX_DEFAULT_ENABLED_PATH}"
  sudo nginx -t
  sudo systemctl reload nginx
}

health_check() {
  if ! command -v curl >/dev/null 2>&1; then
    log "Skipping health check (curl not installed)"
    return
  fi

  local app_port
  local app_token
  local allow_unauthenticated_health
  local url
  local attempts
  local delay_seconds
  local attempt
  local -a curl_args

  app_port="$(read_env_var APP_PORT)"
  app_token="$(read_env_var APP_API_TOKEN)"
  allow_unauthenticated_health="$(read_env_var APP_ALLOW_UNAUTHENTICATED_HEALTH)"
  [[ -n "${app_port}" ]] || app_port="8787"
  url="http://127.0.0.1:${app_port}/health"
  attempts="${HEALTHCHECK_ATTEMPTS:-20}"
  delay_seconds="${HEALTHCHECK_DELAY_SECONDS:-1}"
  curl_args=(-fsS)

  if [[ "${allow_unauthenticated_health}" == "false" && -n "${app_token}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${app_token}")
  fi
  curl_args+=("${url}")

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl "${curl_args[@]}" >/dev/null; then
      log "Health check passed (attempt ${attempt}/${attempts}): ${url}"
      return
    fi
    if (( attempt < attempts )); then
      sleep "${delay_seconds}"
    fi
  done

  log "Health check failed after ${attempts} attempts: ${url}"
  sudo systemctl --no-pager --lines=40 status "${SERVICE_NAME}" || true
  sudo journalctl -u "${SERVICE_NAME}" --no-pager -n 120 || true
  fail "Application is not reachable at ${url}"
}

main() {
  parse_args "$@"
  require_cmd git
  require_cmd sudo
  require_cmd systemctl

  if [[ "${SKIP_DEPS}" != "true" || "${SKIP_CHECK}" != "true" ]]; then
    require_cmd npm
  fi

  ensure_repo
  ensure_clean_worktree
  sudo -v

  local branch
  branch="$(resolve_branch)"
  update_code "${branch}"
  install_dependencies
  run_checks
  restart_service
  refresh_nginx
  health_check

  log "Update complete."
}

main "$@"
