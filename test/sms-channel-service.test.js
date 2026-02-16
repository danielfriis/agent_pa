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
      includeSequenceLabels: true,
      replyMessageDelayMs: 0,
      defaultSystemPrompt: "Reply as SMS.",
      unauthorizedReply: "This phone number is not authorized to use this SMS channel.",
      fallbackReply: "Fallback.",
      twilio: {
        authToken: "",
        authTokensByAccountSid: {},
        validateSignature: false,
        webhookBaseUrl: "",
        allowedToNumbers: [],
        allowedFromNumbers: []
      },
      ...overrides
    }
  }
});

const withMockedFetch = async (mock, run) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const twilioForm = (overrides = {}) => ({
  AccountSid: "AC123",
  MessageSid: "SM123",
  From: "+15550001111",
  To: "+15559998888",
  Body: "hello",
  ...overrides
});

const createTwilioSignature = ({ authToken, signatureUrl, form }) => {
  const signatureBase = Object.keys(form)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}${form[key]}`)
    .join("");
  return createHmac("sha1", authToken)
    .update(`${signatureUrl}${signatureBase}`, "utf8")
    .digest("base64");
};

const unescapeTwimlText = (value) =>
  String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

const extractTwilioMessages = (xml) =>
  [...String(xml || "").matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map((match) =>
    unescapeTwimlText(match[1])
  );

const normalizeWhitespace = (value) => String(value || "").replace(/\s+/g, " ").trim();
const stripSequenceLabel = (value) => String(value || "").replace(/^\[\d+\/\d+\]\s*/, "");

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
  assert.equal(sentMessages[0].channel, "sms:twilio");
  assert.match(
    sentMessages[0].system,
    /You still have access to all tools and skills available in this runtime/
  );
});

test("sms channel /session-new creates a new session and rebinds later messages", async () => {
  const createdSessions = [];
  const sentMessages = [];
  const sessionStore = createMockSessionStore();
  let nextId = 1;
  const agentService = {
    createSession: async (args) => {
      createdSessions.push(args);
      return { id: `ses_${nextId++}`, title: args.title };
    },
    sendUserMessage: async (args) => {
      sentMessages.push(args);
      return { assistantText: "ok" };
    }
  };
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig()
  });

  const first = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm({ Body: "hello" }),
    path: "/channels/sms/inbound",
    queryString: ""
  });
  const rotate = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm({ Body: "/session-new Deep work", MessageSid: "SM124" }),
    path: "/channels/sms/inbound",
    queryString: ""
  });
  const afterRotate = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm({ Body: "continue", MessageSid: "SM125" }),
    path: "/channels/sms/inbound",
    queryString: ""
  });

  assert.equal(first.ok, true);
  assert.equal(rotate.ok, true);
  assert.equal(afterRotate.ok, true);
  assert.equal(first.sessionId, "ses_1");
  assert.equal(rotate.sessionId, "ses_2");
  assert.equal(afterRotate.sessionId, "ses_2");
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].sessionId, "ses_1");
  assert.equal(sentMessages[1].sessionId, "ses_2");
  assert.deepEqual(createdSessions, [
    { title: "SMS +15550001111 -> +15559998888", channel: "sms:twilio" },
    { title: "Deep work", channel: "sms:twilio" }
  ]);
  assert.deepEqual(extractTwilioMessages(rotate.response.body), [
    "Started new session: ses_2"
  ]);
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

test("sms channel returns canned response for sender numbers outside allowlist", async () => {
  const createdSessions = [];
  const sentMessages = [];
  const sessionStore = createMockSessionStore();
  const agentService = {
    createSession: async (args) => {
      createdSessions.push(args);
      return { id: "ses_1" };
    },
    sendUserMessage: async (args) => {
      sentMessages.push(args);
      return { assistantText: "Hi" };
    }
  };
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig({
      unauthorizedReply: "Not allowed.",
      twilio: {
        authToken: "",
        authTokensByAccountSid: {},
        validateSignature: false,
        webhookBaseUrl: "",
        allowedToNumbers: [],
        allowedFromNumbers: ["+15550000000"]
      }
    })
  });

  const result = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm(),
    path: "/channels/sms/inbound",
    queryString: ""
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.sessionId, null);
  assert.equal(createdSessions.length, 0);
  assert.equal(sentMessages.length, 0);
  assert.deepEqual(extractTwilioMessages(result.response.body), ["Not allowed."]);
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
  const signature = createTwilioSignature({
    authToken,
    signatureUrl: "https://example.com/channels/sms/inbound",
    form
  });

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

test("sms channel splits long assistant replies into multiple Twilio messages with sequence labels by default", async () => {
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
    assert.match(message, /^\[\d+\/\d+\]\s/);
  }
  const textWithoutLabels = messages.map(stripSequenceLabel).join(" ");
  assert.equal(normalizeWhitespace(textWithoutLabels), normalizeWhitespace(longReply));
});

test("sms channel can disable sequence labels when configured", async () => {
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
    config: createSmsConfig({ maxReplyChars, includeSequenceLabels: false })
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
    assert.doesNotMatch(message, /^\[\d+\/\d+\]\s/);
  }
  assert.equal(normalizeWhitespace(messages.join(" ")), normalizeWhitespace(longReply));
});

test("sms channel normalizes markdown-heavy assistant replies for plain SMS text", async () => {
  const sessionStore = createMockSessionStore();
  const richReply = [
    "# Strap options",
    "No stall 🙂",
    "**Models** in stock:",
    "- [Scandinavian Photo](https://example.com/shop)",
    "- `Peak Design` cuff",
    "I'll give you **one specific strap** → right now."
  ].join("\n");
  const agentService = {
    createSession: async () => ({ id: "ses_1" }),
    sendUserMessage: async () => ({ assistantText: richReply })
  };
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig()
  });

  const result = await service.handleInboundWebhook({
    headers: {},
    form: twilioForm(),
    path: "/channels/sms/inbound",
    queryString: ""
  });

  assert.equal(result.ok, true);
  const combined = extractTwilioMessages(result.response.body).join("\n");
  assert.ok(!combined.includes("# Strap options"));
  assert.ok(!combined.includes("**"));
  assert.ok(!combined.includes("`"));
  assert.ok(!combined.includes("]("));
  assert.ok(!combined.includes("→"));
  assert.match(combined, /Scandinavian Photo \(https:\/\/example\.com\/shop\)/);
  assert.match(combined, /one specific strap -> right now\./);
});

test("sms channel can pace multipart replies via Twilio API when delay is configured", async () => {
  const sessionStore = createMockSessionStore();
  const longReply =
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const delayMs = 20;
  const agentService = {
    createSession: async () => ({ id: "ses_1" }),
    sendUserMessage: async () => ({ assistantText: longReply })
  };
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig({
      maxReplyChars: 24,
      replyMessageDelayMs: delayMs,
      twilio: {
        authToken: "token",
        authTokensByAccountSid: {},
        validateSignature: true,
        webhookBaseUrl: "https://example.com",
        allowedToNumbers: [],
        allowedFromNumbers: []
      }
    })
  });

  const outboundBodies = [];
  const outboundTimes = [];
  const form = twilioForm();
  const signature = createTwilioSignature({
    authToken: "token",
    signatureUrl: "https://example.com/channels/sms/inbound",
    form
  });
  await withMockedFetch(async (url, init = {}) => {
    assert.match(String(url), /\/Accounts\/AC123\/Messages\.json$/);
    outboundTimes.push(Date.now());
    outboundBodies.push(new URLSearchParams(String(init.body || "")));
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ sid: `SM-outbound-${outboundTimes.length}` })
    };
  }, async () => {
    const result = await service.handleInboundWebhook({
      headers: { "x-twilio-signature": signature },
      form,
      path: "/channels/sms/inbound",
      queryString: ""
    });

    assert.equal(result.ok, true);
    assert.deepEqual(extractTwilioMessages(result.response.body), []);
  });

  assert.ok(outboundBodies.length > 1);
  for (const body of outboundBodies) {
    assert.equal(body.get("From"), "+15559998888");
    assert.equal(body.get("To"), "+15550001111");
    assert.ok(body.get("Body"));
  }
  for (let i = 1; i < outboundTimes.length; i += 1) {
    assert.ok(outboundTimes[i] - outboundTimes[i - 1] >= delayMs - 2);
  }
});

test("sms channel falls back to TwiML when delayed outbound send cannot start", async () => {
  const sessionStore = createMockSessionStore();
  const longReply =
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
  const agentService = {
    createSession: async () => ({ id: "ses_1" }),
    sendUserMessage: async () => ({ assistantText: longReply })
  };
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig({
      maxReplyChars: 24,
      replyMessageDelayMs: 20,
      twilio: {
        authToken: "token",
        authTokensByAccountSid: {},
        validateSignature: true,
        webhookBaseUrl: "https://example.com",
        allowedToNumbers: [],
        allowedFromNumbers: []
      }
    })
  });

  const form = twilioForm();
  const signature = createTwilioSignature({
    authToken: "token",
    signatureUrl: "https://example.com/channels/sms/inbound",
    form
  });
  const result = await withMockedFetch(async () => {
    throw new Error("network down");
  }, async () =>
    service.handleInboundWebhook({
      headers: { "x-twilio-signature": signature },
      form,
      path: "/channels/sms/inbound",
      queryString: ""
    })
  );

  assert.equal(result.ok, true);
  assert.ok(extractTwilioMessages(result.response.body).length > 1);
});

test("sms channel serializes concurrent inbound requests for the same conversation", async () => {
  const sentMessages = [];
  const sessionStore = createMockSessionStore();
  let inFlight = 0;
  let maxInFlight = 0;
  const agentService = {
    createSession: async () => ({ id: "ses_1" }),
    sendUserMessage: async (args) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sentMessages.push(args.text);
      await new Promise((resolve) => setTimeout(resolve, args.text === "first" ? 40 : 0));
      inFlight -= 1;
      return { assistantText: `ack: ${args.text}` };
    }
  };
  const service = createSmsChannelService({
    agentService,
    sessionStore,
    config: createSmsConfig()
  });

  const first = service.handleInboundWebhook({
    headers: {},
    form: twilioForm({ Body: "first", MessageSid: "SM-first" }),
    path: "/channels/sms/inbound",
    queryString: ""
  });
  const second = service.handleInboundWebhook({
    headers: {},
    form: twilioForm({ Body: "second", MessageSid: "SM-second" }),
    path: "/channels/sms/inbound",
    queryString: ""
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.deepEqual(sentMessages, ["first", "second"]);
  assert.equal(maxInFlight, 1);
});
