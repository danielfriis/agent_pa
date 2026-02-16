import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createUpdateCommandService } from "../src/update-command-service.js";

const waitForUpdateToFinish = async (service, timeoutMs = 4000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await service.getStatus();
    if (!status.running) return status;
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("Timed out waiting for update run to finish");
};

const writeExecutableScript = async (scriptPath, body) => {
  await fs.writeFile(scriptPath, body, "utf8");
  await fs.chmod(scriptPath, 0o755);
};

test("update command service starts update script and stores success status", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "update-service-"));
  const scriptPath = path.join(tempDir, "update-server.sh");

  await writeExecutableScript(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "running update: $*"
`
  );

  const service = createUpdateCommandService({
    enabled: true,
    scriptPath,
    timeoutMs: 2000,
    maxOutputChars: 2000
  });

  const started = await service.startUpdate({
    argsText: "--skip-check",
    channel: "api"
  });

  assert.equal(started.ok, true);
  assert.equal(started.run.status, "running");

  const status = await waitForUpdateToFinish(service);
  assert.equal(status.running, false);
  assert.equal(status.lastRun.status, "succeeded");
  assert.equal(status.lastRun.exitCode, 0);
  assert.match(status.lastRun.stdout, /running update: --skip-check/);
});

test("update command service rejects concurrent starts while a run is in progress", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "update-service-"));
  const scriptPath = path.join(tempDir, "update-server.sh");

  await writeExecutableScript(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
sleep 0.2
echo "done"
`
  );

  const service = createUpdateCommandService({
    enabled: true,
    scriptPath,
    timeoutMs: 4000,
    maxOutputChars: 2000
  });

  const first = await service.startUpdate({ channel: "api" });
  const second = await service.startUpdate({ channel: "api" });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, "already_running");

  const status = await waitForUpdateToFinish(service);
  assert.equal(status.lastRun.status, "succeeded");
});

test("update command service validates allowed update arguments", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "update-service-"));
  const scriptPath = path.join(tempDir, "update-server.sh");

  await writeExecutableScript(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "ok"
`
  );

  const service = createUpdateCommandService({
    enabled: true,
    scriptPath,
    timeoutMs: 2000,
    maxOutputChars: 2000
  });

  const result = await service.startUpdate({
    argsText: "--unknown-option"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_args");
  assert.match(result.error, /Unsupported update option/);
});
