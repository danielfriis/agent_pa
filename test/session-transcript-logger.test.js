import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSessionTranscriptLogger } from "../src/session-transcript-logger.js";

const readJsonLines = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

test("session transcript logger appends JSONL entries per session", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pa-session-log-"));
  const logsDir = path.join(tmpRoot, "logs");

  try {
    const logger = createSessionTranscriptLogger({
      enabled: true,
      logsDir,
      maxEntryChars: 12,
      includeSystem: false
    });

    await logger.appendEntry({
      type: "assistant_response",
      sessionId: "ses_1",
      channel: "api",
      userText: "hello world from user",
      assistantText: "assistant reply for transcript",
      assistantPartTypes: ["text", "tool-call"],
      noReply: false,
      system: "hidden system",
      model: { providerID: "openai", modelID: "gpt-5-mini" },
      diagnostics: {
        recentMessages: "recent messages summary should be truncated",
        latestAssistantInfo: "latest assistant info should be truncated"
      }
    });

    await logger.appendEntry({
      type: "request_error",
      sessionId: "ses_1",
      channel: "api",
      userText: "retry this",
      error: "upstream failed"
    });

    const entries = await readJsonLines(path.join(logsDir, "ses_1.jsonl"));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, "assistant_response");
    assert.equal(entries[0].channel, "api");
    assert.equal(entries[0].userText, "hello wor...");
    assert.equal(entries[0].assistantText, "assistant...");
    assert.deepEqual(entries[0].assistantPartTypes, ["text", "tool-call"]);
    assert.equal(entries[0].system, undefined);
    assert.deepEqual(entries[0].model, { providerID: "openai", modelID: "gpt-5-mini" });
    assert.equal(entries[0].diagnostics.recentMessages, "recent me...");
    assert.equal(entries[0].diagnostics.latestAssistantInfo, "latest as...");
    assert.equal(entries[1].type, "request_error");
    assert.equal(entries[1].error, "upstream ...");
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("session transcript logger does nothing when disabled", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pa-session-log-"));
  const logsDir = path.join(tmpRoot, "logs");

  try {
    const logger = createSessionTranscriptLogger({
      enabled: false,
      logsDir
    });
    await logger.appendEntry({
      type: "assistant_response",
      sessionId: "ses_1",
      channel: "api",
      userText: "hello",
      assistantText: "world"
    });

    const stat = await fs.stat(logsDir).catch(() => null);
    assert.equal(stat, null);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
