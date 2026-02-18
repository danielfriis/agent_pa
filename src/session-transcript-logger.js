import fs from "node:fs/promises";
import path from "node:path";

const sanitizeSessionId = (sessionId) =>
  String(sessionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");

const trimToString = (value) => String(value || "").trim();

const truncateText = (value, maxChars) => {
  const text = trimToString(value);
  if (!text) return "";
  if (!Number.isInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
};

const toModelShape = (model) => {
  if (!model || typeof model !== "object") return null;
  const providerID = trimToString(model.providerID);
  const modelID = trimToString(model.modelID);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
};

const toDiagnosticsShape = (diagnostics, maxChars) => {
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const output = {};

  const recentMessages = truncateText(diagnostics.recentMessages, maxChars);
  if (recentMessages) output.recentMessages = recentMessages;

  const latestAssistantInfo = truncateText(diagnostics.latestAssistantInfo, maxChars);
  if (latestAssistantInfo) output.latestAssistantInfo = latestAssistantInfo;

  return Object.keys(output).length ? output : null;
};

const normalizePartTypes = (partTypes) => {
  if (!Array.isArray(partTypes)) return [];
  return partTypes
    .map((item) => trimToString(item))
    .filter(Boolean)
    .slice(0, 20);
};

export const createSessionTranscriptLogger = (options = {}) => {
  const enabled = Boolean(options.enabled);
  const logsDir = path.resolve(
    options.logsDir || path.resolve(process.cwd(), "agent_state/session_logs")
  );
  const maxEntryChars =
    Number.isInteger(options.maxEntryChars) && options.maxEntryChars > 0
      ? options.maxEntryChars
      : 2000;
  const includeSystem = Boolean(options.includeSystem);

  let ensurePromise = null;
  const ensureDir = async () => {
    if (!enabled) return;
    if (!ensurePromise) {
      ensurePromise = fs.mkdir(logsDir, { recursive: true });
    }
    await ensurePromise;
  };

  const appendEntry = async (event = {}) => {
    if (!enabled) return;

    const sessionId = sanitizeSessionId(event.sessionId);
    if (!sessionId) return;
    await ensureDir();

    const entry = {
      at: trimToString(event.at) || new Date().toISOString(),
      type: trimToString(event.type) || "assistant_response",
      sessionId,
      channel: trimToString(event.channel) || "unknown",
      userText: truncateText(event.userText, maxEntryChars),
      assistantText: truncateText(event.assistantText, maxEntryChars),
      assistantPartTypes: normalizePartTypes(event.assistantPartTypes),
      noReply: Boolean(event.noReply)
    };

    const agent = truncateText(event.agent, maxEntryChars);
    if (agent) entry.agent = agent;

    const model = toModelShape(event.model);
    if (model) entry.model = model;

    if (includeSystem) {
      const system = truncateText(event.system, maxEntryChars);
      if (system) entry.system = system;
    }

    const diagnostics = toDiagnosticsShape(event.diagnostics, maxEntryChars);
    if (diagnostics) entry.diagnostics = diagnostics;

    const error = truncateText(event.error, maxEntryChars);
    if (error) entry.error = error;

    const logPath = path.join(logsDir, `${sessionId}.jsonl`);
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  };

  return {
    enabled,
    logsDir,
    appendEntry
  };
};
