import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createSmsChannelService } from "../src/sms-channel-service.js";

const createMockSessionStore = () => {
  const sessionById = new Map();

  const upsertSession = async (sessionId, patch) => {
    const current = sessionById.get(sessionId) || { id: sessionId };
    const merged = {
      ...current,
      ...patch,
      id: sessionId
    };
    sessionById.set(sessionId, merged);
    return merged;
  };

  return {
    getSession: async (sessionId) => sessionById.get(sessionId) || null,
    listSessions: async () => [...sessionById.values()],
    upsertSession,
    all: () => [...sessionById.values()]
  };
};

const createSmsConfig = (overrides = {}) => ({
  channels: {
    sms: {
      enabled: true,
      provider: "twilio",
      inboundPath: "/channels/sms/inbound",
      allowUnauthenticatedInbound: true,
      maxReplyChars: 320,
      defaultSystemPrompt: "Reply as SMS.",
      fallbackReply: "Fallback.",
      twilio: {
        authToken: "",
        authTokensByAccountSid: {},
        validateSignature: false,
        webhookBaseUrl: "",
        allowedToNumbers: []
      },
      ...overrides
    }
  }
});

const twilioForm = (overrides = {}) => ({
  AccountSid: "AC123",
  MessageSid: "SM123",
  From: "+15550001111",
  To: "+15559998888",
  Body: "hello",
  ...overrides
});

const extractTwilioMessages = (xml) =>
  [...String(xml || "").matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map((match) => match[1]);

const normalizeWhitespace = (value) => String(value || "").replace(/\s+/g, " ").trim();

test("sms channel creates a session then reuses it for same provider/account/to/from tuple", async () => {
  const createdSessions = [];
  const sentMessages = [];
  const sessionStore = createMockSessionStore();
  const agentService = {
    createSession: async (args) => {
      createdSessions.push(args);
      return { id: "ses_1", title: args.title };
    },
    sendUserMessage: async (args) => {
      sentMessages.push(args);
      return { assistantText: "Hello from assistant" };
    }
  };
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig()
  });

  const first = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm(),
    path: "/channels/sms/inbound",
    queryString: ""
  });
  const second = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm({ Body: "second message", MessageSid: "SM124" }),
    path: "/channels/sms/inbound",
    queryString: ""
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.sessionId, "ses_1");
  assert.equal(second.sessionId, "ses_1");
  assert.equal(createdSessions.length, 1);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].sessionId, "ses_1");
  assert.equal(sentMessages[1].sessionId, "ses_1");
  assert.match(
    sentMessages[0].system,
    /You still have access to all tools and skills available in this runtime/
  );
});

test("sms channel rejects inbound messages for destination numbers outside allowlist", async () => {
  const sessionStore = createMockSessionStore();
  const agentService = {
    createSession: async () => ({ id: "ses_1" }),
    sendUserMessage: async () => ({ assistantText: "Hi" })
  };
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig({
      twilio: {
        authToken: "",
        authTokensByAccountSid: {},
        validateSignature: false,
        webhookBaseUrl: "",
        allowedToNumbers: ["+15550000000"]
      }
    })
  });

  const result = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm(),
    path: "/channels/sms/inbound",
    queryString: ""
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("sms channel validates Twilio webhook signatures when enabled", async () => {
  const authToken = "secret";
  const sessionStore = createMockSessionStore();
  const agentService = {
    createSession: async () => ({ id: "ses_1" }),
    sendUserMessage: async () => ({ assistantText: "Hi" })
  };
  const config = createSmsConfig({
    twilio: {
      authToken,
      authTokensByAccountSid: {},
      validateSignature: true,
      webhookBaseUrl: "https://example.com",
      allowedToNumbers: []
    }
  });
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config
  });
  const form = twilioForm();
  const signatureBase = Object.keys(form)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}${form[key]}`)
    .join("");
  const signature = createHmac("sha1", authToken)
    .update(`https://example.com/channels/sms/inbound${signatureBase}`, "utf8")
    .digest("base64");

  const valid = await service.handleInboundWebhook({
    headers: { "x-twilio-signature": signature },
    form,
    path: "/channels/sms/inbound",
    queryString: ""
  });
  const invalid = await service.handleInboundWebhook({
    headers: { "x-twilio-signature": "invalid" },
    form,
    path: "/channels/sms/inbound",
    queryString: ""
  });

  assert.equal(valid.ok, true);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 403);
});

test("sms channel splits long assistant replies into multiple Twilio messages", async () => {
  const sessionStore = createMockSessionStore();
  const longReply =
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const agentService = {
    createSession: async () => ({ id: "ses_1" }),
    sendUserMessage: async () => ({ assistantText: longReply })
  };
  const maxReplyChars = 24;
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig({ maxReplyChars })
  });

  const result = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm(),
    path: "/channels/sms/inbound",
    queryString: ""
  });

  assert.equal(result.ok, true);
  const messages = extractTwilioMessages(result.response.body);
  assert.ok(messages.length > 1);
  for (const message of messages) {
    assert.ok(message.length <= maxReplyChars);
  }
  assert.equal(normalizeWhitespace(messages.join(" ")), normalizeWhitespace(longReply));
});
