import { sendJson, readJsonBody } from "./http-utils.js";

const latestAssistantMessage = (messages) =>
  [...messages].reverse().find((message) => message.role === "assistant") || null;

export const createSessionRouteHandler = ({ agentService }) => async (req, res, path) => {
  if (req.method === "GET" && path === "/sessions") {
    const listing = await agentService.listSessions();
    sendJson(res, 200, listing);
    return true;
  }

  if (req.method === "POST" && path === "/sessions") {
    const body = await readJsonBody(req);
    const created = await agentService.createSession({
      title: typeof body.title === "string" ? body.title : undefined,
      channel: typeof body.channel === "string" && body.channel ? body.channel : "api"
    });
    sendJson(res, 201, { session: created });
    return true;
  }

  const messagePath = path.match(/^\/sessions\/([^/]+)\/message$/);
  if (req.method === "POST" && messagePath) {
    const sessionId = messagePath[1];
    const body = await readJsonBody(req);
    if (typeof body.text !== "string" || !body.text.trim()) {
      sendJson(res, 400, { error: "Body must include string field `text`." });
      return true;
    }

    const reply = await agentService.sendUserMessage({
      sessionId,
      text: body.text,
      noReply: Boolean(body.noReply),
      agent: body.agent,
      model: body.model,
      system: typeof body.system === "string" ? body.system : undefined
    });

    const normalized = await agentService.listMessages(sessionId);
    const latest = latestAssistantMessage(normalized);
    const latestHasText = Boolean(latest?.text && latest.text.trim());
    const assistant = latestHasText
      ? latest
      : reply.assistantText
        ? {
            id: latest?.id || null,
            role: "assistant",
            time: latest?.time || null,
            text: reply.assistantText
          }
        : latest || null;

    sendJson(res, 200, {
      sessionId,
      assistant,
      assistantPartTypes: reply.assistantPartTypes,
      diagnostics: reply.diagnostics,
      messages: normalized
    });
    return true;
  }

  const getMessagePath = path.match(/^\/sessions\/([^/]+)\/messages$/);
  if (req.method === "GET" && getMessagePath) {
    const sessionId = getMessagePath[1];
    const messages = await agentService.listMessages(sessionId);
    sendJson(res, 200, { sessionId, messages });
    return true;
  }

  return false;
};
