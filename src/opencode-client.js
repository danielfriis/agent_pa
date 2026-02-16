import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

export class OpenCodeClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.host = config.host;
    this.port = config.port;
    this.directory = config.directory;
    this.username = config.username;
    this.password = config.password;
    this.autostart = config.autostart;
    this.requestTimeoutMs =
      Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs >= 0
        ? config.requestTimeoutMs
        : 0;
    this.proc = null;
  }

  get authHeader() {
    if (!this.password) return null;
    const basic = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return `Basic ${basic}`;
  }

  async startServerIfConfigured() {
    if (!this.autostart || this.proc) return;
    try {
      await this.health();
      return;
    } catch {
      // OpenCode is not reachable yet, continue with autostart.
    }

    const localBin = path.resolve(process.cwd(), "node_modules", ".bin", "opencode");
    const opencodeBin = process.env.OPENCODE_BIN || (existsSync(localBin) ? localBin : "opencode");

    this.proc = spawn(
      opencodeBin,
      [
        "serve",
        "--hostname",
        this.host,
        "--port",
        String(this.port)
      ],
      {
        stdio: "inherit",
        env: process.env
      }
    );
  }

  async stopServer() {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
  }

  buildUrl(pathname, options = {}) {
    const url = new URL(
      `${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`
    );
    if (!options.noDirectory && this.directory) {
      url.searchParams.set("directory", this.directory);
    }
    return url.toString();
  }

  async request(pathname, options = {}) {
    const url = this.buildUrl(pathname, options);
    const headers = { "content-type": "application/json", ...(options.headers || {}) };
    const auth = this.authHeader;
    if (auth) headers.authorization = auth;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? options.timeoutMs
      : this.requestTimeoutMs;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timeoutHandle =
      controller &&
      setTimeout(() => {
        controller.abort();
      }, timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller?.signal
      });
    } catch (error) {
      if (controller?.signal.aborted && error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `OpenCode ${options.method || "GET"} ${pathname} timed out after ${timeoutMs}ms`
        );
      }
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenCode ${options.method || "GET"} ${pathname} failed: ${response.status} ${errorText}`);
    }

    if (options.raw) return response;
    if (response.status === 204) return null;

    const text = await response.text();
    if (!text.trim()) return null;

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        `OpenCode ${options.method || "GET"} ${pathname} returned non-JSON response: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async health() {
    return this.request("/global/health", { method: "GET", noDirectory: true });
  }

  async listSessions() {
    return this.request("/session", { method: "GET" });
  }

  async createSession(title) {
    return this.request("/session", {
      method: "POST",
      body: title ? { title } : {}
    });
  }

  async listMessages(sessionId) {
    return this.request(`/session/${sessionId}/message`, { method: "GET" });
  }

  async sendMessage(sessionId, payload) {
    return this.request(`/session/${sessionId}/message`, {
      method: "POST",
      body: payload
    });
  }

  async pipeGlobalEvents(nodeResponse) {
    const response = await this.request("/global/event", {
      method: "GET",
      headers: { accept: "text/event-stream" },
      noDirectory: true,
      timeoutMs: 0,
      raw: true
    });

    nodeResponse.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });

    if (!response.body) {
      nodeResponse.end();
      return;
    }

    Readable.fromWeb(response.body).pipe(nodeResponse);
  }
}
