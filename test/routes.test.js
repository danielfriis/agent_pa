import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { createRouteHandler } from "../src/routes.js";

const createRequest = ({ method, url, body, headers = {} }) => {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost", ...headers };
  return req;
};

const createResponse = () => {
  let statusCode = 0;
  let responseHeaders = {};
  let body = "";

  return {
    writeHead(code, headers = {}) {
      statusCode = code;
      responseHeaders = headers;
    },
    end(chunk = "") {
      body += chunk.toString();
    },
    result() {
      return {
        statusCode,
        headers: responseHeaders,
        body,
        json: body ? JSON.parse(body) : null
      };
    }
  };
};

const buildRoute = (overrides = {}) => {
  const calls = {
    createSession: [],
    sendUserMessage: [],
    listSessions: 0,
    listMessages: []
  };

  const opencodeClient = {
    health: async () => ({ ok: true }),
    pipeGlobalEvents: async () => {},
    listSessions: async () => [],
    createSession: async () => {
      throw new Error("route should not call opencodeClient.createSession directly");
    },
    sendMessage: async () => {
      throw new Error("route should not call opencodeClient.sendMessage directly");
    },
    listMessages: async () => [
      {
        info: { id: "usr_1", role: "user", time: { created: 1735689600000 } },
        parts: [{ type: "text", text: "hello" }]
      },
      {
        info: { id: "asst_1", role: "assistant", time: { created: 1735689601000 } },
        parts: [{ type: "text", text: "world" }]
      }
    ],
    ...overrides.opencodeClient
  };

  const sessionStore = {
    listSessions: async () => [],
    upsertSession: async () => {},
    ...overrides.sessionStore
  };

  const workspace = {
    summary: () => ({ rootDir: "/tmp/config", skillsDir: "/tmp/config/skills" }),
    listSkills: async () => [],
    readMemory: async () => "",
    appendMemory: async () => {},
    readSystemPrompt: async () => "",
    writeSystemPrompt: async () => {},
    ...overrides.workspace
  };

  const agentService = {
    listSessions: async () => {
      calls.listSessions += 1;
      return {
        sessions: [{ id: "ses_1", title: "My Session", local: null }]
      };
    },
    listMessages: async (sessionId) => {
      calls.listMessages.push(sessionId);
      return [
        {
          id: "usr_1",
          role: "user",
          time: "2025-01-01T00:00:00.000Z",
          text: "hello"
        },
        {
          id: "asst_1",
          role: "assistant",
          time: "2025-01-01T00:00:01.000Z",
          text: "world"
        }
      ];
    },
    createSession: async (args) => {
      calls.createSession.push(args);
      return { id: "ses_1", title: args.title || "Untitled" };
    },
    sendUserMessage: async (args) => {
      calls.sendUserMessage.push(args);
      return { assistantText: "world", assistantPartTypes: [], diagnostics: null };
    },
    ...overrides.agentService
  };

  const config = {
    agent: { workspaceDir: "/tmp/workspace" },
    memory: { maxChars: 2000 },
    ...overrides.config
  };

  const route = createRouteHandler({
    opencodeClient,
    sessionStore,
    workspace,
    config,
    agentService
  });

  return { route, calls };
};

const invoke = async (route, options) => {
  const req = createRequest(options);
  const res = createResponse();
  await route(req, res);
  return res.result();
};

test("GET /sessions delegates listing to agentService", async () => {
  const { route, calls } = buildRoute();
  const response = await invoke(route, {
    method: "GET",
    url: "/sessions"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.listSessions, 1);
  assert.deepEqual(response.json, {
    sessions: [{ id: "ses_1", title: "My Session", local: null }]
  });
});

test("POST /sessions delegates session creation to agentService", async () => {
  const { route, calls } = buildRoute();
  const response = await invoke(route, {
    method: "POST",
    url: "/sessions",
    body: { title: "My Session" }
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls.createSession, [{ title: "My Session", channel: "api" }]);
  assert.equal(response.json.session.id, "ses_1");
});

test("POST /sessions/:id/message delegates message handling to agentService", async () => {
  const { route, calls } = buildRoute();
  const response = await invoke(route, {
    method: "POST",
    url: "/sessions/ses_1/message",
    body: {
      text: "hello",
      noReply: true,
      agent: "default",
      model: { providerID: "openai", modelID: "gpt-4.1" },
      system: "custom system"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.sendUserMessage, [
    {
      sessionId: "ses_1",
      text: "hello",
      noReply: true,
      agent: "default",
      model: { providerID: "openai", modelID: "gpt-4.1" },
      system: "custom system"
    }
  ]);
  assert.deepEqual(calls.listMessages, ["ses_1"]);
  assert.equal(response.json.sessionId, "ses_1");
  assert.equal(response.json.assistant.role, "assistant");
  assert.equal(response.json.assistant.text, "world");
});

test("GET /sessions/:id/messages delegates message listing to agentService", async () => {
  const { route, calls } = buildRoute();
  const response = await invoke(route, {
    method: "GET",
    url: "/sessions/ses_1/messages"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.listMessages, ["ses_1"]);
  assert.equal(response.json.sessionId, "ses_1");
  assert.equal(response.json.messages.length, 2);
  assert.equal(response.json.messages[1].role, "assistant");
  assert.equal(response.json.messages[1].text, "world");
});

test("POST /sessions/:id/message rejects malformed JSON", async () => {
  const { route } = buildRoute();
  const req = Readable.from([Buffer.from("{ malformed")]);
  req.method = "POST";
  req.url = "/sessions/ses_1/message";
  req.headers = { host: "localhost" };

  const res = createResponse();
  await route(req, res);
  const response = res.result();

  assert.equal(response.statusCode, 400);
  assert.equal(response.json.error, "Invalid JSON body");
});

test("authenticated routes return 401 when auth is enabled and token is missing", async () => {
  const { route } = buildRoute({
    config: {
      security: {
        requireAuth: true,
        apiToken: "secret-token",
        allowUnauthenticatedHealth: true
      }
    }
  });

  const response = await invoke(route, {
    method: "GET",
    url: "/sessions"
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["www-authenticate"], "Bearer");
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error, "Unauthorized");
});

test("authenticated routes accept bearer token when auth is enabled", async () => {
  const { route, calls } = buildRoute({
    config: {
      security: {
        requireAuth: true,
        apiToken: "secret-token",
        allowUnauthenticatedHealth: true
      }
    }
  });

  const response = await invoke(route, {
    method: "GET",
    url: "/sessions",
    headers: {
      authorization: "Bearer secret-token"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.listSessions, 1);
});

test("authenticated routes accept x-api-key when auth is enabled", async () => {
  const { route, calls } = buildRoute({
    config: {
      security: {
        requireAuth: true,
        apiToken: "secret-token",
        allowUnauthenticatedHealth: true
      }
    }
  });

  const response = await invoke(route, {
    method: "GET",
    url: "/sessions",
    headers: {
      "x-api-key": "secret-token"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.listSessions, 1);
});

test("GET /health stays public when allowUnauthenticatedHealth is true", async () => {
  const { route } = buildRoute({
    config: {
      security: {
        requireAuth: true,
        apiToken: "secret-token",
        allowUnauthenticatedHealth: true
      }
    }
  });

  const response = await invoke(route, {
    method: "GET",
    url: "/health"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.ok, true);
});

test("GET /health requires auth when allowUnauthenticatedHealth is false", async () => {
  const { route } = buildRoute({
    config: {
      security: {
        requireAuth: true,
        apiToken: "secret-token",
        allowUnauthenticatedHealth: false
      }
    }
  });

  const response = await invoke(route, {
    method: "GET",
    url: "/health"
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json.error, "Unauthorized");
});
