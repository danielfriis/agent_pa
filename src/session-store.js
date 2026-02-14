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
    await fs.writeFile(
      this.sessionPath(sessionId),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8"
    );
    return payload;
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
    try {
      return await this.readSessionFile(sessionId);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
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
      const raw = await fs.readFile(path.join(this.sessionsDir, entry.name), "utf8");
      const parsed = JSON.parse(raw);
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
