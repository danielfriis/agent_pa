import assert from "node:assert/strict";
import test from "node:test";

import { createAgentService } from "../src/agent-service.js";

const passthroughMemory = async (payload) => payload;

test("sendUserMessage retries once after transient OpenCode unavailability", async () => {
  let sendCalls = 0;
  let healthCalls = 0;
  const upserts = [];

  const service = createAgentService({
    opencodeClient: {
      health: async () => {
        healthCalls += 1;
        return { ok: true };
      },
      sendMessage: async () => {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw new Error("fetch failed");
        }
        return {
          parts: [{ type: "text", text: "Recovered reply" }]
        };
      },
      listMessages: async () => []
    },
    sessionStore: {
      upsertSession: async (sessionId, patch) => {
        upserts.push({ sessionId, patch });
      }
    },
    withMemorySystem: passthroughMemory
  });

  const result = await service.sendUserMessage({
    sessionId: "ses_1",
    text: "hello"
  });

  assert.equal(result.assistantText, "Recovered reply");
  assert.equal(sendCalls, 2);
  assert.equal(healthCalls, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].sessionId, "ses_1");
});

test("sendUserMessage does not retry non-connectivity errors", async () => {
  let sendCalls = 0;
  let healthCalls = 0;

  const service = createAgentService({
    opencodeClient: {
      health: async () => {
        healthCalls += 1;
        return { ok: true };
      },
      sendMessage: async () => {
        sendCalls += 1;
        throw new Error("OpenCode POST /session/ses_1/message failed: 500 boom");
      },
      listMessages: async () => []
    },
    sessionStore: {
      upsertSession: async () => {}
    },
    withMemorySystem: passthroughMemory
  });

  await assert.rejects(
    service.sendUserMessage({
      sessionId: "ses_1",
      text: "hello"
    }),
    /500 boom/
  );

  assert.equal(sendCalls, 1);
  assert.equal(healthCalls, 0);
});

test("sendUserMessage returns fallback text for non-text assistant outputs", async () => {
  const upserts = [];

  const service = createAgentService({
    opencodeClient: {
      health: async () => ({ ok: true }),
      sendMessage: async () => ({
        parts: [{ type: "tool-call" }]
      }),
      listMessages: async () => [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: "run it" }]
        },
        {
          info: { role: "assistant" },
          parts: [{ type: "tool-call" }]
        }
      ]
    },
    sessionStore: {
      upsertSession: async (sessionId, patch) => {
        upserts.push({ sessionId, patch });
      }
    },
    withMemorySystem: passthroughMemory
  });

  const result = await service.sendUserMessage({
    sessionId: "ses_1",
    text: "run it"
  });

  assert.equal(
    result.assistantText,
    "Completed with non-text output (tool-call). Ask me to summarize what I did."
  );
  assert.deepEqual(result.assistantPartTypes, ["tool-call"]);
  assert.equal(result.diagnostics, null);
  assert.equal(upserts.length, 1);
  assert.equal(
    upserts[0].patch.lastAssistantMessage,
    "Completed with non-text output (tool-call). Ask me to summarize what I did."
  );
});
