import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureManagedAgentTools } from "../src/opencode-sync.js";

test("ensureManagedAgentTools creates managed tool files", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-pa-managed-tools-"));
  try {
    const result = await ensureManagedAgentTools(tempRoot);

    assert.equal(path.basename(result.addMemoryToolFile), "add_memory.js");
    assert.equal(path.basename(result.fetchWebpageToolFile), "fetch_webpage.js");

    const addMemorySource = await fs.readFile(result.addMemoryToolFile, "utf8");
    const fetchWebpageSource = await fs.readFile(result.fetchWebpageToolFile, "utf8");

    assert.match(addMemorySource, /description:\s*"Append a timestamped entry to persistent memory\."/);
    assert.match(fetchWebpageSource, /Fetch readable webpage text with fallback/);
    assert.match(fetchWebpageSource, /toJinaMirrorUrl/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
