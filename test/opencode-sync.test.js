import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureManagedAgentTools,
  syncOpenCodeSkills,
  syncOpenCodeTools
} from "../src/opencode-sync.js";

test("ensureManagedAgentTools creates managed tool files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pa-managed-tools-"));
  try {
    const result = await ensureManagedAgentTools(tempRoot);

    assert.equal(path.basename(result.addMemoryToolFile), "add_memory.js");
    assert.equal(path.basename(result.fetchWebpageToolFile), "fetch_webpage.js");
    assert.equal(path.basename(result.createDownloadLinkToolFile), "create_download_link.js");

    const addMemorySource = await fs.readFile(result.addMemoryToolFile, "utf8");
    const fetchWebpageSource = await fs.readFile(result.fetchWebpageToolFile, "utf8");
    const createDownloadLinkSource = await fs.readFile(result.createDownloadLinkToolFile, "utf8");

    assert.match(addMemorySource, /description:\s*"Append a timestamped entry to persistent memory\."/);
    assert.match(fetchWebpageSource, /Fetch readable webpage text with fallback/);
    assert.match(fetchWebpageSource, /toJinaMirrorUrl/);
    assert.match(createDownloadLinkSource, /Create a validated download link/);
    assert.match(createDownloadLinkSource, /workspace-relative file path/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("syncOpenCodeTools layers defaults and state with state override", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pa-tool-layering-"));
  try {
    const defaultsDir = path.join(tempRoot, "defaults");
    const stateDir = path.join(tempRoot, "state");
    const opencodeDirectory = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(defaultsDir, "tools"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "tools"), { recursive: true });
    await fs.writeFile(path.join(defaultsDir, "tools", "shared.js"), "default-shared", "utf8");
    await fs.writeFile(path.join(defaultsDir, "tools", "default-only.js"), "default-only", "utf8");
    await fs.writeFile(path.join(stateDir, "tools", "shared.js"), "state-shared", "utf8");
    await fs.writeFile(path.join(stateDir, "tools", "state-only.js"), "state-only", "utf8");

    const result = await syncOpenCodeTools({
      agentDefaultsDir: defaultsDir,
      agentStateDir: stateDir,
      opencodeDirectory
    });

    const targetDir = path.join(opencodeDirectory, ".opencode", "tools");
    const files = (await fs.readdir(targetDir)).sort();
    assert.ok(files.includes("shared.js"));
    assert.ok(files.includes("default-only.js"));
    assert.ok(files.includes("state-only.js"));
    assert.ok(files.includes("add_memory.js"));
    assert.ok(files.includes("fetch_webpage.js"));
    assert.ok(files.includes("create_download_link.js"));
    assert.equal(await fs.readFile(path.join(targetDir, "shared.js"), "utf8"), "state-shared");
    assert.equal(result.syncedCount >= 6, true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("syncOpenCodeSkills layers defaults and state with state override", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pa-skill-layering-"));
  try {
    const defaultsDir = path.join(tempRoot, "defaults");
    const stateDir = path.join(tempRoot, "state");
    const opencodeDirectory = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(defaultsDir, "skills"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(defaultsDir, "skills", "shared.md"), "default shared", "utf8");
    await fs.writeFile(path.join(defaultsDir, "skills", "base.md"), "default base", "utf8");
    await fs.writeFile(path.join(stateDir, "skills", "shared.md"), "state shared", "utf8");
    await fs.writeFile(path.join(stateDir, "skills", "custom.md"), "state custom", "utf8");

    const result = await syncOpenCodeSkills({
      agentDefaultsDir: defaultsDir,
      agentStateDir: stateDir,
      opencodeDirectory
    });

    const targetDir = path.join(opencodeDirectory, ".opencode", "skills");
    const files = (await fs.readdir(targetDir)).sort();
    assert.deepEqual(files, ["base.md", "custom.md", "shared.md"]);
    assert.equal(await fs.readFile(path.join(targetDir, "shared.md"), "utf8"), "state shared");
    assert.equal(result.syncedCount, 3);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
