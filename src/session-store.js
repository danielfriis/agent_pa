import fs from "node:fs/promises";
import path from "node:path";

const sanitizeSessionId = (sessionId) =>
  String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "_");

const toTimestamp = (value) => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

const isErrorCode = (error, code) =>
  Boolean(error && typeof error === "object" && error.code === code);

export class SessionStore {
  constructor(options) {
    this.sessionsDir = options.sessionsDir;
  }

  async ensure() {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  sessionPath(sessionId) {
    return path.join(this.sessionsDir, `${sanitizeSessionId(sessionId)}.json`);
  }

  async readSessionFile(sessionId) {
    const raw = await fs.readFile(this.sessionPath(sessionId), "utf8");
    return JSON.parse(raw);
  }

  async writeSessionFile(sessionId, data) {
    const payload = { ...data, id: sessionId };
    const finalPath = this.sessionPath(sessionId);
    const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, finalPath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    return payload;
  }

  async quarantineInvalidSessionFile(filePath, error) {
    const quarantinePath = `${filePath}.invalid-${Date.now()}`;
    const detail = error instanceof Error ? error.message : String(error);

    try {
      await fs.rename(filePath, quarantinePath);
      process.stderr.write(
        `[agent-pa] warning: invalid session JSON moved to ${quarantinePath}: ${detail}\n`
      );
    } catch (renameError) {
      if (isErrorCode(renameError, "ENOENT")) return;
      const renameDetail =
        renameError instanceof Error ? renameError.message : String(renameError);
      process.stderr.write(
        `[agent-pa] warning: invalid session JSON at ${filePath}: ${detail} (rename failed: ${renameDetail})\n`
      );
    }
  }

  async upsertSession(sessionId, patch) {
    const current = (await this.getSession(sessionId)) || { id: sessionId };
    const merged = {
      ...current,
      ...patch,
      id: sessionId,
      updatedAt: new Date().toISOString()
    };
    return this.writeSessionFile(sessionId, merged);
  }

  async getSession(sessionId) {
    const sessionPath = this.sessionPath(sessionId);
    try {
      return await this.readSessionFile(sessionId);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return null;
      }
      if (error instanceof SyntaxError) {
        await this.quarantineInvalidSessionFile(sessionPath, error);
        return null;
      }
      throw error;
    }
  }

  async listSessions() {
    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    const sessions = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.sessionsDir, entry.name);
      let parsed;
      try {
        const raw = await fs.readFile(filePath, "utf8");
        parsed = JSON.parse(raw);
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) continue;
        if (error instanceof SyntaxError) {
          await this.quarantineInvalidSessionFile(filePath, error);
          continue;
        }
        throw error;
      }
      if (parsed && typeof parsed === "object" && parsed.id) {
        sessions.push(parsed);
      }
    }

    return sessions.sort((a, b) => {
      const aTime = toTimestamp(a.updatedAt || a.createdAt);
      const bTime = toTimestamp(b.updatedAt || b.createdAt);
      return bTime - aTime;
    });
  }
}
