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

test("readSystemPrompt layers defaults and state with state override by filename", async () => {
  const defaultsDir = await createTempRoot();
  const stateDir = await createTempRoot();
  try {
    const workspace = new AgentWorkspace({
      defaultsDir,
      stateDir
    });
    await workspace.ensure();

    await Promise.all([
      fs.writeFile(path.join(defaultsDir, "system", "a.md"), "Default A", "utf8"),
      fs.writeFile(path.join(defaultsDir, "system", "shared.md"), "Default Shared", "utf8"),
      fs.writeFile(path.join(stateDir, "system", "b.md"), "State B", "utf8"),
      fs.writeFile(path.join(stateDir, "system", "shared.md"), "State Shared", "utf8")
    ]);

    const result = await workspace.readSystemPrompt();
    assert.equal(result, "Default A\n\nState B\n\nState Shared");
  } finally {
    await fs.rm(defaultsDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("listSkills returns merged defaults and state skill names with state overrides", async () => {
  const defaultsDir = await createTempRoot();
  const stateDir = await createTempRoot();
  try {
    const workspace = new AgentWorkspace({
      defaultsDir,
      stateDir
    });
    await workspace.ensure();
    await fs.mkdir(path.join(defaultsDir, "skills", "shared"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "skills", "shared"), { recursive: true });

    await Promise.all([
      fs.writeFile(path.join(defaultsDir, "skills", "base.md"), "# Base", "utf8"),
      fs.writeFile(path.join(defaultsDir, "skills", "shared", "SKILL.md"), "# Shared Default", "utf8"),
      fs.writeFile(path.join(stateDir, "skills", "custom.md"), "# Custom", "utf8"),
      fs.writeFile(path.join(stateDir, "skills", "shared", "SKILL.md"), "# Shared State", "utf8")
    ]);

    const skills = await workspace.listSkills();
    assert.deepEqual(skills, ["base.md", "custom.md", "shared"]);
  } finally {
    await fs.rm(defaultsDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
