import path from "node:path";

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const resolveDir = (value, fallback) => path.resolve(value || fallback);

const agentWorkspaceDir = resolveDir(
  process.env.AGENT_WORKSPACE_DIR,
  path.resolve(process.cwd(), "agent_workspace")
);
const agentConfigDir = resolveDir(
  process.env.AGENT_CONFIG_DIR,
  path.resolve(process.cwd(), "agent_config")
);

export const config = {
  agent: {
    workspaceDir: agentWorkspaceDir,
    configDir: agentConfigDir
  },
  memory: {
    maxChars: int(process.env.MEMORY_MAX_CHARS, 6000)
  },
  app: {
    host: process.env.APP_HOST || "127.0.0.1",
    port: int(process.env.APP_PORT, 8787)
  },
  security: {
    requireAuth: bool(process.env.APP_REQUIRE_AUTH, Boolean(process.env.APP_API_TOKEN)),
    apiToken: process.env.APP_API_TOKEN || "",
    allowUnauthenticatedHealth: bool(process.env.APP_ALLOW_UNAUTHENTICATED_HEALTH, true)
  },
  sessionStore: {
    sessionsDir: path.resolve(process.env.STORE_DIR || path.resolve(agentConfigDir, "sessions"))
  },
  opencode: {
    baseUrl: process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096",
    host: process.env.OPENCODE_SERVER_HOST || "127.0.0.1",
    port: int(process.env.OPENCODE_SERVER_PORT, 4096),
    directory: resolveDir(process.env.OPENCODE_DIRECTORY, agentWorkspaceDir),
    username: process.env.OPENCODE_SERVER_USERNAME || "opencode",
    password: process.env.OPENCODE_SERVER_PASSWORD || "",
    autostart: bool(process.env.AUTOSTART_OPENCODE, true)
  }
};
