import {
  extractText,
  latestAssistantRaw,
  normalizeMessages,
  readAssistantReplyFromHistory,
  summarizeLatestAssistantInfo,
  summarizeRecentMessages
} from "./message-utils.js";

const isValidModel = (value) =>
  Boolean(
    value &&
      typeof value === "object" &&
      typeof value.providerID === "string" &&
      value.providerID &&
      typeof value.modelID === "string" &&
      value.modelID
  );

const isOpenCodeUnavailable = (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes("fetch failed") || detail.includes("ECONNREFUSED");
};

export const createAgentService = ({
  opencodeClient,
  sessionStore,
  withMemorySystem
}) => {
  const waitForOpenCode = async (attempts = 20, delayMs = 500) => {
    for (let i = 0; i < attempts; i += 1) {
      try {
        await opencodeClient.health();
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  };

  const createSession = async ({ title, channel = "api" } = {}) => {
    const session = await opencodeClient.createSession(title);
    await sessionStore.upsertSession(session.id, {
      id: session.id,
      title: session.title || title || "Untitled",
      createdAt: new Date().toISOString(),
      channel
    });
    return session;
  };

  const listSessions = async () => {
    const local = await sessionStore.listSessions();
    let remote = [];
    let unavailableMessage = null;
    try {
      remote = await opencodeClient.listSessions();
    } catch (error) {
      if (isOpenCodeUnavailable(error)) {
        unavailableMessage = error instanceof Error ? error.message : String(error);
      } else {
        throw error;
      }
    }

    const localById = new Map(local.map((item) => [item.id, item]));
    const merged = (remote || []).map((session) => ({
      ...session,
      local: localById.get(session.id) || null
    }));
    if (!merged.length && local.length) {
      merged.push(...local.map((item) => ({ id: item.id, local: item, offlineOnly: true })));
    }

    return unavailableMessage ? { sessions: merged, warning: unavailableMessage } : { sessions: merged };
  };

  const listMessages = async (sessionId) => {
    const messages = await opencodeClient.listMessages(sessionId);
    return normalizeMessages(messages);
  };

  const sendUserMessage = async ({
    sessionId,
    text,
    noReply = false,
    agent,
    model,
    system
  }) => {
    let payload = {
      parts: [{ type: "text", text }],
      noReply: Boolean(noReply)
    };

    if (agent) payload.agent = agent;
    if (isValidModel(model)) {
      payload.model = {
        providerID: model.providerID,
        modelID: model.modelID
      };
    }

    payload = await withMemorySystem(payload, system);

    const result = await opencodeClient.sendMessage(sessionId, payload);
    let assistantText = extractText(result?.parts || []);
    let assistantPartTypes = [];

    if (!assistantText.trim()) {
      const historyOutput = await readAssistantReplyFromHistory(opencodeClient, sessionId, text);
      assistantText = historyOutput.text;
      assistantPartTypes = historyOutput.partTypes;
    }

    await sessionStore.upsertSession(sessionId, {
      lastUserMessage: text,
      lastAssistantMessage: assistantText,
      lastMessageAt: new Date().toISOString()
    });

    if (assistantText || assistantPartTypes.length) {
      return {
        assistantText,
        assistantPartTypes,
        diagnostics: null
      };
    }

    const messages = await opencodeClient.listMessages(sessionId);
    const raw = latestAssistantRaw(messages);
    return {
      assistantText,
      assistantPartTypes,
      diagnostics: {
        recentMessages: summarizeRecentMessages(messages),
        latestAssistantInfo: summarizeLatestAssistantInfo(messages),
        latestAssistantRaw: raw
      }
    };
  };

  return {
    waitForOpenCode,
    listSessions,
    listMessages,
    createSession,
    sendUserMessage
  };
};
