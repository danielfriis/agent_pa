import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/session-store.js";

const createTempRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), "agent-pa-session-store-"));

test("listSessions skips malformed JSON files and keeps valid sessions", async () => {
  const rootDir = await createTempRoot();
  const sessionsDir = path.join(rootDir, "sessions");
  try {
    const store = new SessionStore({ sessionsDir });
    await store.ensure();

    await fs.writeFile(
      path.join(sessionsDir, "valid.json"),
      `${JSON.stringify({ id: "ses_valid", updatedAt: "2026-02-16T00:00:00.000Z" })}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(sessionsDir, "broken.json"),
      '{"id":"ses_broken"} trailing-garbage',
      "utf8"
    );

    const sessions = await store.listSessions();
    assert.deepEqual(
      sessions.map((session) => session.id),
      ["ses_valid"]
    );

    const names = await fs.readdir(sessionsDir);
    assert.ok(names.includes("valid.json"));
    assert.ok(names.some((name) => name.startsWith("broken.json.invalid-")));
    assert.ok(!names.includes("broken.json"));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("getSession returns null for malformed JSON and upsert rewrites clean file", async () => {
  const rootDir = await createTempRoot();
  const sessionsDir = path.join(rootDir, "sessions");
  try {
    const store = new SessionStore({ sessionsDir });
    await store.ensure();

    await fs.writeFile(
      path.join(sessionsDir, "ses_1.json"),
      '{"id":"ses_1","title":"broken"} trailing-garbage',
      "utf8"
    );

    const before = await store.getSession("ses_1");
    assert.equal(before, null);

    await store.upsertSession("ses_1", { title: "Recovered" });
    const after = await store.getSession("ses_1");
    assert.equal(after?.id, "ses_1");
    assert.equal(after?.title, "Recovered");

    const names = await fs.readdir(sessionsDir);
    assert.ok(names.includes("ses_1.json"));
    assert.ok(names.some((name) => name.startsWith("ses_1.json.invalid-")));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
