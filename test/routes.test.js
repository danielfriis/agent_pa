import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { createRouteHandler } from "../src/routes.js";

const createRequest = ({ method, url, body, rawBody, headers = {} }) => {
  const payload = [];
  if (rawBody !== undefined) {
    payload.push(Buffer.from(rawBody));
  } else if (body !== undefined) {
    payload.push(Buffer.from(JSON.stringify(body)));
  }
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
      const contentType =
        responseHeaders["content-type"] || responseHeaders["Content-Type"] || "";
      let json = null;
      if (body && String(contentType).includes("application/json")) {
        json = JSON.parse(body);
      }
      return {
        statusCode,
        headers: responseHeaders,
        body,
        json
      };
    }
  };
};

const buildRoute = (overrides = {}) => {
  const calls = {
    createSession: [],
    sendUserMessage: [],
    listSessions: 0,
    listMessages: [],
    appendMemory: [],
    writeSystemPrompt: [],
    smsInbound: []
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
    appendMemory: async (text) => {
      calls.appendMemory.push(text);
    },
    readSystemPrompt: async () => "",
    writeSystemPrompt: async (text) => {
      calls.writeSystemPrompt.push(text);
    },
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
    opencode: { directory: "/tmp/workspace" },
    security: {
      requireAuth: false,
      apiToken: "",
      allowUnauthenticatedHealth: true
    },
    channels: {
      sms: {
        enabled: false,
        inboundPath: "/channels/sms/inbound",
        allowUnauthenticatedInbound: true
      }
    },
    ...overrides.config
  };

  const smsChannelService = {
    isEnabled: () => Boolean(config.channels?.sms?.enabled),
    inboundPath: () => config.channels?.sms?.inboundPath || "/channels/sms/inbound",
    handleInboundWebhook: async (args) => {
      calls.smsInbound.push(args);
      return {
        ok: true,
        status: 200,
        response: {
          contentType: "text/xml; charset=utf-8",
          body: '<?xml version="1.0" encoding="UTF-8"?><Response><Message>ok</Message></Response>'
        }
      };
    },
    ...overrides.smsChannelService
  };

  const route = createRouteHandler({
    opencodeClient,
    sessionStore,
    workspace,
    config,
    agentService,
    smsChannelService
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
      system: "custom system",
      channel: "api"
    }
  ]);
  assert.deepEqual(calls.listMessages, ["ses_1"]);
  assert.equal(response.json.sessionId, "ses_1");
  assert.equal(response.json.assistant.role, "assistant");
  assert.equal(response.json.assistant.text, "world");
});

test("POST /sessions/:id/message prefers fallback text when latest assistant message is empty", async () => {
  const { route } = buildRoute({
    agentService: {
      sendUserMessage: async () => ({
        assistantText: "Completed with non-text output (tool-call). Ask me to summarize what I did.",
        assistantPartTypes: ["tool-call"],
        diagnostics: null
      }),
      listMessages: async () => [
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
          text: ""
        }
      ]
    }
  });

  const response = await invoke(route, {
    method: "POST",
    url: "/sessions/ses_1/message",
    body: { text: "hello" }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json.assistant.role, "assistant");
  assert.equal(
    response.json.assistant.text,
    "Completed with non-text output (tool-call). Ask me to summarize what I did."
  );
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

test("POST /sessions/:id/message returns 504 when upstream times out", async () => {
  const { route } = buildRoute({
    agentService: {
      sendUserMessage: async () => {
        throw new Error("OpenCode POST /session/ses_1/message timed out after 180000ms");
      }
    }
  });

  const response = await invoke(route, {
    method: "POST",
    url: "/sessions/ses_1/message",
    body: { text: "hello" }
  });

  assert.equal(response.statusCode, 504);
  assert.equal(response.json.error, "Request timed out");
  assert.match(response.json.detail, /timed out/i);
});

test("GET /workspace returns agent working directory info", async () => {
  const { route } = buildRoute({
    config: {
      agent: { workspaceDir: "/tmp/workspace" },
      opencode: { directory: "/tmp/opencode-workspace" }
    }
  });

  const response = await invoke(route, {
    method: "GET",
    url: "/workspace"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, {
    workspaceDir: "/tmp/workspace",
    opencodeDirectory: "/tmp/opencode-workspace"
  });
});

test("POST /channels/sms/inbound delegates form payload to sms channel service", async () => {
  const { route, calls } = buildRoute({
    config: {
      channels: {
        sms: {
          enabled: true,
          inboundPath: "/channels/sms/inbound",
          allowUnauthenticatedInbound: true
        }
      }
    }
  });

  const response = await invoke(route, {
    method: "POST",
    url: "/channels/sms/inbound",
    rawBody: "From=%2B15550001111&To=%2B15559998888&Body=hello",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/xml; charset=utf-8");
  assert.equal(calls.smsInbound.length, 1);
  assert.equal(calls.smsInbound[0].form.From, "+15550001111");
  assert.equal(calls.smsInbound[0].form.To, "+15559998888");
  assert.equal(calls.smsInbound[0].form.Body, "hello");
});

test("POST /channels/sms/inbound/ also matches SMS route", async () => {
  const { route, calls } = buildRoute({
    config: {
      channels: {
        sms: {
          enabled: true,
          inboundPath: "/channels/sms/inbound",
          allowUnauthenticatedInbound: true
        }
      }
    }
  });

  const response = await invoke(route, {
    method: "POST",
    url: "/channels/sms/inbound/",
    rawBody: "From=%2B15550001111&To=%2B15559998888&Body=hello",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.smsInbound.length, 1);
  assert.equal(calls.smsInbound[0].path, "/channels/sms/inbound/");
});

test("POST /channels/sms/inbound bypasses app token auth when configured", async () => {
  const { route, calls } = buildRoute({
    config: {
      security: {
        requireAuth: true,
        apiToken: "secret-token",
        allowUnauthenticatedHealth: true
      },
      channels: {
        sms: {
          enabled: true,
          inboundPath: "/channels/sms/inbound",
          allowUnauthenticatedInbound: true
        }
      }
    }
  });

  const response = await invoke(route, {
    method: "POST",
    url: "/channels/sms/inbound",
    rawBody: "From=%2B15550001111&To=%2B15559998888&Body=hello",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.smsInbound.length, 1);
});

test("POST /channels/sms/inbound requires auth when bypass is disabled", async () => {
  const { route } = buildRoute({
    config: {
      security: {
        requireAuth: true,
        apiToken: "secret-token",
        allowUnauthenticatedHealth: true
      },
      channels: {
        sms: {
          enabled: true,
          inboundPath: "/channels/sms/inbound",
          allowUnauthenticatedInbound: false
        }
      }
    }
  });

  const response = await invoke(route, {
    method: "POST",
    url: "/channels/sms/inbound",
    rawBody: "From=%2B15550001111&To=%2B15559998888&Body=hello",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    }
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json.error, "Unauthorized");
});

test("legacy /workspace/* state routes are no longer exposed", async () => {
  const { route } = buildRoute();
  const response = await invoke(route, {
    method: "GET",
    url: "/workspace/memory"
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json, { error: "Not found" });
});

test("GET /state returns state summary with memory preview and skills", async () => {
  const { route } = buildRoute({
    workspace: {
      summary: () => ({
        rootDir: "/tmp/config",
        memoryFile: "/tmp/config/memory/memory.md",
        systemPromptFile: "/tmp/config/system/system-prompt.md",
        skillsDir: "/tmp/config/skills",
        sessionsDir: "/tmp/config/sessions"
      }),
      listSkills: async () => ["skill-a.md", "skill-b.md"],
      readMemory: async () => "persisted memory text"
    },
    config: {
      memory: { maxChars: 8 }
    }
  });

  const response = await invoke(route, {
    method: "GET",
    url: "/state"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, {
    rootDir: "/tmp/config",
    memoryFile: "/tmp/config/memory/memory.md",
    systemPromptFile: "/tmp/config/system/system-prompt.md",
    skillsDir: "/tmp/config/skills",
    sessionsDir: "/tmp/config/sessions",
    skills: ["skill-a.md", "skill-b.md"],
    memoryPreview: "ory text"
  });
});

test("POST /state/memory appends memory and returns updated memory", async () => {
  let memory = "";
  const { route, calls } = buildRoute({
    workspace: {
      readMemory: async () => memory,
      appendMemory: async (text) => {
        calls.appendMemory.push(text);
        memory = `saved: ${text}`;
      }
    }
  });

  const response = await invoke(route, {
    method: "POST",
    url: "/state/memory",
    body: { text: "Remember this" }
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls.appendMemory, ["Remember this"]);
  assert.equal(response.json.memory, "saved: Remember this");
});

test("POST /state/system writes system prompt and returns effective prompt", async () => {
  let systemPrompt = "";
  const { route, calls } = buildRoute({
    workspace: {
      readSystemPrompt: async () => systemPrompt,
      writeSystemPrompt: async (text) => {
        calls.writeSystemPrompt.push(text);
        systemPrompt = `stored: ${text}`;
      }
    }
  });

  const response = await invoke(route, {
    method: "POST",
    url: "/state/system",
    body: { systemPrompt: "You are concise." }
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(calls.writeSystemPrompt, ["You are concise."]);
  assert.equal(response.json.systemPrompt, "stored: You are concise.");
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
