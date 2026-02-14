const HIDDEN_TEXT_PART_TYPES = new Set(["reasoning", "step-start", "step-finish"]);

export const extractText = (parts) => {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (typeof part.type === "string") {
        if (HIDDEN_TEXT_PART_TYPES.has(part.type)) return "";
        if (part.type.startsWith("tool")) return "";
      }
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
};

const normalizeMessageRecord = (item) => {
  const info = item?.info || item;
  const parts = item?.parts || item?.content || [];
  const created = info?.time?.created;
  return {
    id: info?.id,
    role: info?.role,
    time: typeof created === "number" ? new Date(created).toISOString() : null,
    text: extractText(parts)
  };
};

export const normalizeMessages = (messages) => {
  if (!Array.isArray(messages)) return [];
  return messages.map(normalizeMessageRecord);
};

export const getMessageParts = (message) => {
  if (!message || typeof message !== "object") return [];
  if (Array.isArray(message.parts)) return message.parts;
  if (Array.isArray(message.content)) return message.content;
  return [];
};

export const messageRole = (message) => {
  const info = message?.info || message;
  return info?.role;
};

export const extractAssistantOutputFromMessage = (message) => {
  const parts = getMessageParts(message);
  const info = message?.info || {};
  const partText = extractText(parts);
  const fallbackTextCandidates = [
    typeof message?.text === "string" ? message.text : "",
    typeof message?.content === "string" ? message.content : "",
    typeof message?.output === "string" ? message.output : "",
    typeof message?.message === "string" ? message.message : "",
    typeof info?.text === "string" ? info.text : "",
    typeof info?.message === "string" ? info.message : "",
    typeof info?.error === "string" ? info.error : "",
    typeof info?.status === "string" && info.status.toLowerCase() !== "completed"
      ? `status: ${info.status}`
      : "",
    typeof message?.error?.message === "string" ? message.error.message : ""
  ].filter(Boolean);
  const text = partText || fallbackTextCandidates.join("\n");
  const partTypes = parts
    .map((part) => (part && typeof part === "object" ? part.type : null))
    .filter((value) => typeof value === "string");
  return {
    text,
    partTypes: [...new Set(partTypes)]
  };
};

export const summarizeRecentMessages = (messages, max = 6) => {
  if (!Array.isArray(messages) || !messages.length) return "none";
  return messages
    .slice(-max)
    .map((message) => {
      const role = messageRole(message) || "unknown";
      const parts = getMessageParts(message);
      const types = [...new Set(parts.map((part) => part?.type).filter(Boolean))];
      return `${role}[${types.join(",") || "no-parts"}]`;
    })
    .join(" -> ");
};

export const summarizeLatestAssistantInfo = (messages) => {
  if (!Array.isArray(messages) || !messages.length) return "none";
  const latestAssistant = [...messages]
    .reverse()
    .find((message) => messageRole(message) === "assistant");
  if (!latestAssistant) return "none";
  const info = latestAssistant?.info || {};
  const fields = [
    info?.id ? `id=${info.id}` : "",
    info?.status ? `status=${info.status}` : "",
    info?.modelID ? `model=${info.modelID}` : "",
    info?.providerID ? `provider=${info.providerID}` : "",
    info?.error ? `error=${info.error}` : "",
    latestAssistant?.error?.message ? `error=${latestAssistant.error.message}` : ""
  ].filter(Boolean);
  return fields.join(" | ") || "assistant-without-info";
};

export const latestAssistantRaw = (messages) => {
  if (!Array.isArray(messages) || !messages.length) return null;
  return [...messages].reverse().find((message) => messageRole(message) === "assistant") || null;
};

export const findAssistantReplyForInput = (messages, userInput) => {
  if (!Array.isArray(messages) || !messages.length) {
    return { text: "", partTypes: [] };
  }

  const target = userInput.trim();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (messageRole(message) !== "user") continue;
    const userText = extractText(getMessageParts(message)).trim();
    if (userText !== target) continue;

    for (let j = i + 1; j < messages.length; j += 1) {
      const candidate = messages[j];
      if (messageRole(candidate) !== "assistant") continue;
      const output = extractAssistantOutputFromMessage(candidate);
      if (output.text.trim() || output.partTypes.length) {
        return output;
      }
    }
    break;
  }

  const latestAssistant = [...messages]
    .reverse()
    .find((message) => messageRole(message) === "assistant");
  if (!latestAssistant) return { text: "", partTypes: [] };
  return extractAssistantOutputFromMessage(latestAssistant);
};

export const readAssistantReplyFromHistory = async (
  opencodeClient,
  sessionId,
  userInput,
  attempts = 40,
  delayMs = 500
) => {
  for (let i = 0; i < attempts; i += 1) {
    const messages = await opencodeClient.listMessages(sessionId);
    const output = findAssistantReplyForInput(messages, userInput);
    if (output.text.trim() || output.partTypes.length) return output;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { text: "", partTypes: [] };
};
