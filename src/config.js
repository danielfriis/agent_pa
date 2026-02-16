import path from "node:path";

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const normalizeRoutePath = (value, fallback = "/") => {
  const raw = String(value || fallback).trim();
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/, "") || "/";
};

const csv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseSidTokenPairs = (value) => {
  const entries = csv(value);
  const output = {};
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0) continue;
    const sid = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (!sid || !token) continue;
    output[sid] = token;
  }
  return output;
};

const parseJsonRecord = (value) => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, recordValue]) => [String(key).trim(), String(recordValue || "").trim()])
        .filter(([key, recordValue]) => key && recordValue)
    );
  } catch {
    return {};
  }
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

const twilioAuthToken = process.env.SMS_TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN || "";
const twilioAuthTokensByAccountSid = {
  ...parseSidTokenPairs(process.env.SMS_TWILIO_AUTH_TOKENS),
  ...parseJsonRecord(process.env.SMS_TWILIO_AUTH_TOKENS_JSON)
};
const twilioShouldValidateSignaturesByDefault = Boolean(
  twilioAuthToken || Object.keys(twilioAuthTokensByAccountSid).length
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
  sessionLogs: {
    enabled: bool(process.env.SESSION_LOG_ENABLED, false),
    logsDir: resolveDir(
      process.env.SESSION_LOG_DIR,
      path.resolve(agentConfigDir, "session_logs")
    ),
    maxEntryChars: int(process.env.SESSION_LOG_MAX_CHARS, 2000),
    includeSystem: bool(process.env.SESSION_LOG_INCLUDE_SYSTEM, false)
  },
  opencode: {
    baseUrl: process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096",
    host: process.env.OPENCODE_SERVER_HOST || "127.0.0.1",
    port: int(process.env.OPENCODE_SERVER_PORT, 4096),
    directory: resolveDir(process.env.OPENCODE_DIRECTORY, agentWorkspaceDir),
    username: process.env.OPENCODE_SERVER_USERNAME || "opencode",
    password: process.env.OPENCODE_SERVER_PASSWORD || "",
    autostart: bool(process.env.AUTOSTART_OPENCODE, true),
    requestTimeoutMs: int(process.env.OPENCODE_REQUEST_TIMEOUT_MS, 0)
  },
  maintenance: {
    updateCommandEnabled: bool(process.env.UPDATE_COMMAND_ENABLED, true),
    updateScriptPath: resolveDir(
      process.env.UPDATE_SCRIPT_PATH,
      path.resolve(process.cwd(), "deploy/update-server.sh")
    ),
    updateCommandTimeoutMs: int(process.env.UPDATE_COMMAND_TIMEOUT_MS, 20 * 60 * 1000),
    updateCommandMaxOutputChars: int(process.env.UPDATE_COMMAND_MAX_OUTPUT_CHARS, 12000)
  },
  channels: {
    sms: {
      enabled: bool(process.env.SMS_ENABLED, false),
      provider: (process.env.SMS_PROVIDER || "twilio").toLowerCase(),
      inboundPath: normalizeRoutePath(
        process.env.SMS_INBOUND_PATH,
        "/channels/sms/inbound"
      ),
      allowUnauthenticatedInbound: bool(process.env.SMS_ALLOW_UNAUTHENTICATED_INBOUND, true),
      maxReplyChars: int(process.env.SMS_MAX_REPLY_CHARS, 320),
      includeSequenceLabels: bool(process.env.SMS_INCLUDE_SEQUENCE_LABELS, true),
      replyMessageDelayMs: int(process.env.SMS_REPLY_MESSAGE_DELAY_MS, 0),
      defaultSystemPrompt:
        process.env.SMS_DEFAULT_SYSTEM_PROMPT ||
        "You are replying to a user over SMS. Access to all tools and skills remains available; SMS only changes response formatting. Respond with plain text only and keep it concise.",
      unauthorizedReply:
        process.env.SMS_UNAUTHORIZED_REPLY ||
        "This phone number is not authorized to use this SMS channel.",
      fallbackReply:
        process.env.SMS_FALLBACK_REPLY || "I hit an error processing that. Please try again shortly.",
      twilio: {
        authToken: twilioAuthToken,
        authTokensByAccountSid: twilioAuthTokensByAccountSid,
        validateSignature: bool(
          process.env.SMS_TWILIO_VALIDATE_SIGNATURE,
          twilioShouldValidateSignaturesByDefault
        ),
        webhookBaseUrl: process.env.SMS_TWILIO_WEBHOOK_BASE_URL || "",
        allowedToNumbers: csv(process.env.SMS_TWILIO_ALLOWED_TO_NUMBERS),
        allowedFromNumbers: csv(process.env.SMS_TWILIO_ALLOWED_FROM_NUMBERS)
      }
    }
  }
};
