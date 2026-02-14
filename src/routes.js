import { URL } from "node:url";

import { normalizeMessages } from "./message-utils.js";

const isOpenCodeUnavailable = (error) => {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes("fetch failed") || detail.includes("ECONNREFUSED");
};

const sendJson = (res, status, payload) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(JSON.stringify(payload));
};

const readJsonBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

export const createRouteHandler = ({
  opencodeClient,
  sessionStore,
  workspace,
  config,
  withMemorySystem
}) => async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/health") {
      let appInfo = null;
      let opencodeStatus = "ok";
      let opencodeError = null;

      try {
        appInfo = await opencodeClient.health();
      } catch (error) {
        opencodeStatus = "unavailable";
        opencodeError = error instanceof Error ? error.message : String(error);
      }

      sendJson(res, 200, {
        ok: opencodeStatus === "ok",
        app: "agent-pa",
        opencode: {
          status: opencodeStatus,
          info: appInfo,
          error: opencodeError
        }
      });
      return;
    }

    if (req.method === "GET" && path === "/events") {
      await opencodeClient.pipeGlobalEvents(res);
      return;
    }

    if (req.method === "GET" && path === "/sessions") {
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
      sendJson(res, 200, unavailableMessage ? { sessions: merged, warning: unavailableMessage } : { sessions: merged });
      return;
    }

    if (req.method === "GET" && path === "/workspace") {
      const [skills, memory] = await Promise.all([workspace.listSkills(), workspace.readMemory()]);
      sendJson(res, 200, {
        ...workspace.summary(),
        agentWorkspaceDir: config.agent.workspaceDir,
        skills,
        memoryPreview: memory.slice(-config.workspace.memoryMaxChars)
      });
      return;
    }

    if (req.method === "GET" && path === "/workspace/memory") {
      const memory = await workspace.readMemory();
      sendJson(res, 200, { memory });
      return;
    }

    if (req.method === "POST" && path === "/workspace/memory") {
      const body = await readJsonBody(req);
      if (!body.text || typeof body.text !== "string") {
        sendJson(res, 400, { error: "Body must include string field `text`." });
        return;
      }
      await workspace.appendMemory(body.text);
      const memory = await workspace.readMemory();
      sendJson(res, 201, { memory });
      return;
    }

    if (req.method === "GET" && path === "/workspace/system") {
      const systemPrompt = await workspace.readSystemPrompt();
      sendJson(res, 200, { systemPrompt });
      return;
    }

    if (req.method === "POST" && path === "/workspace/system") {
      const body = await readJsonBody(req);
      if (typeof body.systemPrompt !== "string") {
        sendJson(res, 400, { error: "Body must include string field `systemPrompt`." });
        return;
      }
      await workspace.writeSystemPrompt(body.systemPrompt);
      const systemPrompt = await workspace.readSystemPrompt();
      sendJson(res, 201, { systemPrompt });
      return;
    }

    if (req.method === "GET" && path === "/workspace/skills") {
      const skills = await workspace.listSkills();
      sendJson(res, 200, { skills, skillsDir: workspace.summary().skillsDir });
      return;
    }

    if (req.method === "POST" && path === "/sessions") {
      const body = await readJsonBody(req);
      const created = await opencodeClient.createSession(body.title);
      await sessionStore.upsertSession(created.id, {
        id: created.id,
        title: created.title || body.title || "Untitled",
        createdAt: created.time?.created || new Date().toISOString(),
        channel: body.channel || "api"
      });
      sendJson(res, 201, { session: created });
      return;
    }

    const messagePath = path.match(/^\/sessions\/([^/]+)\/message$/);
    if (req.method === "POST" && messagePath) {
      const sessionId = messagePath[1];
      const body = await readJsonBody(req);
      if (!body.text || typeof body.text !== "string") {
        sendJson(res, 400, { error: "Body must include string field `text`." });
        return;
      }

      let payload = {
        parts: [{ type: "text", text: body.text }],
        noReply: Boolean(body.noReply)
      };
      if (body.agent) payload.agent = body.agent;
      if (body.model && body.model.providerID && body.model.modelID) {
        payload.model = {
          providerID: body.model.providerID,
          modelID: body.model.modelID
        };
      }
      payload = await withMemorySystem(payload, typeof body.system === "string" ? body.system : undefined);

      await opencodeClient.sendMessage(sessionId, payload);
      await sessionStore.upsertSession(sessionId, {
        lastUserMessage: body.text,
        lastMessageAt: new Date().toISOString()
      });

      const messages = await opencodeClient.listMessages(sessionId);
      const normalized = normalizeMessages(messages);
      const assistant = [...normalized].reverse().find((m) => m.role === "assistant") || null;

      sendJson(res, 200, {
        sessionId,
        assistant,
        messages: normalized
      });
      return;
    }

    const getMessagePath = path.match(/^\/sessions\/([^/]+)\/messages$/);
    if (req.method === "GET" && getMessagePath) {
      const sessionId = getMessagePath[1];
      const messages = await opencodeClient.listMessages(sessionId);
      sendJson(res, 200, { sessionId, messages: normalizeMessages(messages) });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      error: "Request failed",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
};
