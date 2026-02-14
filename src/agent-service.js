import {
  extractText,
  latestAssistantRaw,
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
    createSession,
    sendUserMessage
  };
};
