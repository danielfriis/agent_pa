import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSharedChatCommand,
  sharedChatCommandHelpText
} from "../src/shared-chat-commands.js";

test("parseSharedChatCommand parses shared slash commands", () => {
  assert.deepEqual(parseSharedChatCommand("/help"), {
    isCommand: true,
    name: "help"
  });
  assert.deepEqual(parseSharedChatCommand("/session"), {
    isCommand: true,
    name: "session"
  });
  assert.deepEqual(parseSharedChatCommand("/session-new Sprint planning"), {
    isCommand: true,
    name: "session-new",
    title: "Sprint planning"
  });
  assert.deepEqual(parseSharedChatCommand("/update --branch main --skip-check"), {
    isCommand: true,
    name: "update",
    argsText: "--branch main --skip-check"
  });
  assert.deepEqual(parseSharedChatCommand("/update-status"), {
    isCommand: true,
    name: "update-status"
  });
});

test("parseSharedChatCommand ignores unrelated or malformed commands", () => {
  assert.deepEqual(parseSharedChatCommand("hello"), { isCommand: false });
  assert.deepEqual(parseSharedChatCommand("/session-newish"), { isCommand: false });
  assert.deepEqual(parseSharedChatCommand(""), { isCommand: false });
});

test("sharedChatCommandHelpText lists session-new command", () => {
  assert.match(sharedChatCommandHelpText(), /\/session-new \[title\]/);
  assert.match(sharedChatCommandHelpText(), /\/update-status/);
});
