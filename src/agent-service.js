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

const fallbackAssistantText = ({ assistantPartTypes = [], diagnostics = null }) => {
  const uniquePartTypes = [...new Set(assistantPartTypes.filter((type) => typeof type === "string"))];
  if (uniquePartTypes.length) {
    return `Completed with non-text output (${uniquePartTypes.join(", ")}). Ask me to summarize what I did.`;
  }

  if (diagnostics?.latestAssistantInfo && diagnostics.latestAssistantInfo !== "none") {
    return `I finished processing but no plain-text reply was produced (${diagnostics.latestAssistantInfo}). Ask me to summarize what happened.`;
  }

  return "I finished processing but no plain-text reply was produced. Ask me to summarize what happened.";
};

export const createAgentService = ({
  opencodeClient,
  sessionStore,
  withMemorySystem,
  sessionTranscriptLogger = null
}) => {
  const appendSessionTranscript = async (entry) => {
    if (!sessionTranscriptLogger || typeof sessionTranscriptLogger.appendEntry !== "function") return;
    try {
      await sessionTranscriptLogger.appendEntry(entry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[agent-pa] warning: failed to append session transcript for ${entry.sessionId}: ${detail}\n`
      );
    }
  };

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

  const sendMessageWithRecovery = async (sessionId, payload) => {
    try {
      return await opencodeClient.sendMessage(sessionId, payload);
    } catch (error) {
      if (!isOpenCodeUnavailable(error)) throw error;

      const ready = await waitForOpenCode();
      if (!ready) throw error;

      return opencodeClient.sendMessage(sessionId, payload);
    }
  };

  const sendUserMessage = async ({
    sessionId,
    text,
    noReply = false,
    agent,
    model,
    system,
    channel
  }) => {
    try {
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

      const result = await sendMessageWithRecovery(sessionId, payload);
      let assistantText = extractText(result?.parts || []);
      let assistantPartTypes = [];
      let diagnostics = null;

      if (!assistantText.trim()) {
        const historyOutput = await readAssistantReplyFromHistory(opencodeClient, sessionId, text);
        assistantText = historyOutput.text;
        assistantPartTypes = historyOutput.partTypes;
      }

      if (!assistantText.trim() && !assistantPartTypes.length) {
        const messages = await opencodeClient.listMessages(sessionId);
        const raw = latestAssistantRaw(messages);
        diagnostics = {
          recentMessages: summarizeRecentMessages(messages),
          latestAssistantInfo: summarizeLatestAssistantInfo(messages),
          latestAssistantRaw: raw
        };
      }

      const assistantTextForUser = assistantText.trim()
        ? assistantText
        : fallbackAssistantText({ assistantPartTypes, diagnostics });

      await sessionStore.upsertSession(sessionId, {
        lastUserMessage: text,
        lastAssistantMessage: assistantTextForUser,
        lastMessageAt: new Date().toISOString()
      });

      await appendSessionTranscript({
        type: "assistant_response",
        sessionId,
        channel: channel || "unknown",
        userText: text,
        assistantText: assistantTextForUser,
        assistantPartTypes,
        noReply: Boolean(noReply),
        agent,
        model: isValidModel(model) ? model : null,
        system,
        diagnostics
      });

      return {
        assistantText: assistantTextForUser,
        assistantPartTypes,
        diagnostics
      };
    } catch (error) {
      await appendSessionTranscript({
        type: "request_error",
        sessionId,
        channel: channel || "unknown",
        userText: text,
        noReply: Boolean(noReply),
        agent,
        model: isValidModel(model) ? model : null,
        system,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };

  return {
    waitForOpenCode,
    listSessions,
    listMessages,
    createSession,
    sendUserMessage
  };
};
