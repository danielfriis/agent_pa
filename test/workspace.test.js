import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentWorkspace } from "../src/workspace.js";

const createTempRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), "agent-pa-workspace-"));

test("readSystemPrompt loads all markdown files from system directory in deterministic order", async () => {
  const rootDir = await createTempRoot();
  try {
    const workspace = new AgentWorkspace(rootDir);
    await workspace.ensure();

    await Promise.all([
      fs.writeFile(path.join(rootDir, "system", "b.md"), "Second file\n", "utf8"),
      fs.writeFile(path.join(rootDir, "system", "a.md"), "First file\n", "utf8"),
      fs.writeFile(path.join(rootDir, "system", "ignore.txt"), "ignored\n", "utf8"),
      fs.writeFile(path.join(rootDir, "system", "empty.md"), "   \n", "utf8")
    ]);

    const result = await workspace.readSystemPrompt();
    assert.equal(result, "First file\n\nSecond file");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("writeSystemPrompt updates system-prompt.md while keeping other markdown prompt files", async () => {
  const rootDir = await createTempRoot();
  try {
    const workspace = new AgentWorkspace(rootDir);
    await workspace.ensure();

    await fs.writeFile(path.join(rootDir, "system", "identity.md"), "Role-based identity", "utf8");
    await workspace.writeSystemPrompt("Base system instructions");

    const result = await workspace.readSystemPrompt();
    assert.equal(result, "Role-based identity\n\nBase system instructions");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
