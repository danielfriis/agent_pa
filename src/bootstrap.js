import "dotenv/config";

import fs from "node:fs/promises";
import http from "node:http";

import { startTerminalChat } from "./chat.js";
import { config } from "./config.js";
import { createAgentService } from "./agent-service.js";
import { createMemorySystemInjector } from "./memory-system.js";
import { OpenCodeClient } from "./opencode-client.js";
import { syncOpenCodeConfig, syncOpenCodeSkills } from "./opencode-sync.js";
import { createRouteHandler } from "./routes.js";
import { createSessionTranscriptLogger } from "./session-transcript-logger.js";
import { createSmsChannelService } from "./sms-channel-service.js";
import { SessionStore } from "./session-store.js";
import { createUpdateCommandService } from "./update-command-service.js";
import { AgentWorkspace } from "./workspace.js";

export const main = async () => {
  if (config.security.requireAuth && !config.security.apiToken) {
    throw new Error("APP_REQUIRE_AUTH=true requires APP_API_TOKEN to be set.");
  }

  // Ensure child processes (OpenCode + tools) receive absolute workspace/config paths.
  process.env.AGENT_DEFAULTS_DIR = config.agent.defaultsDir;
  process.env.AGENT_STATE_DIR = config.agent.stateDir;
  process.env.AGENT_CONFIG_DIR = config.agent.stateDir;
  process.env.AGENT_WORKSPACE_DIR = config.agent.workspaceDir;
  process.env.OPENCODE_DIRECTORY = config.opencode.directory;
  process.env.AGENT_APP_BASE_URL = (
    config.app.publicBaseUrl || `http://${config.app.host}:${config.app.port}`
  ).replace(/\/+$/, "");

  const opencodeClient = new OpenCodeClient(config.opencode);
  const workspace = new AgentWorkspace({
    defaultsDir: config.agent.defaultsDir,
    stateDir: config.agent.stateDir,
    memoryMaxChars: config.memory.maxChars
  });
  const sessionStore = new SessionStore(config.sessionStore);
  const sessionTranscriptLogger = createSessionTranscriptLogger(config.sessionLogs);
  const withMemorySystem = createMemorySystemInjector(workspace);
  const agentService = createAgentService({
    opencodeClient,
    sessionStore,
    withMemorySystem,
    sessionTranscriptLogger
  });
  const updateCommandService = createUpdateCommandService({
    enabled: config.maintenance.updateCommandEnabled,
    scriptPath: config.maintenance.updateScriptPath,
    statusFilePath: config.maintenance.updateStatusFilePath,
    timeoutMs: config.maintenance.updateCommandTimeoutMs,
    maxOutputChars: config.maintenance.updateCommandMaxOutputChars
  });
  const smsChannelService = createSmsChannelService({
    agentService,
    sessionStore,
    config,
    updateCommandService
  });

  await fs.mkdir(config.agent.workspaceDir, { recursive: true });
  await workspace.ensure();
  await sessionStore.ensure();
  if (sessionTranscriptLogger.enabled) {
    process.stdout.write(
      `[agent-pa] session transcript logging enabled (${sessionTranscriptLogger.logsDir})\n`
    );
  }

  const syncSkills = () =>
    syncOpenCodeSkills({
      agentDefaultsDir: config.agent.defaultsDir,
      agentStateDir: config.agent.stateDir,
      opencodeDirectory: config.opencode.directory
    });

  const openCodeSync = await syncOpenCodeConfig({
    agentDefaultsDir: config.agent.defaultsDir,
    agentStateDir: config.agent.stateDir,
    opencodeDirectory: config.opencode.directory
  });
  process.stdout.write(
    `[agent-pa] tool sync: ${openCodeSync.toolSync.syncedCount} file(s), ${openCodeSync.toolSync.removedCount} removed (${openCodeSync.toolSync.targetDir})\n`
  );
  process.stdout.write(`[agent-pa] tool defaults dir: ${openCodeSync.toolConfig.sourceDir}\n`);
  process.stdout.write(
    `[agent-pa] skill sync: ${openCodeSync.skillSync.syncedCount} file(s), ${openCodeSync.skillSync.removedCount} removed (${openCodeSync.skillSync.targetDir})\n`
  );

  await opencodeClient.startServerIfConfigured();

  const route = createRouteHandler({
    opencodeClient,
    workspace,
    config,
    agentService,
    smsChannelService,
    updateCommandService
  });

  const server = http.createServer((req, res) => {
    route(req, res);
  });

  server.listen(config.app.port, config.app.host, () => {
    process.stdout.write(
      `[agent-pa] listening at http://${config.app.host}:${config.app.port}\n`
    );
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await opencodeClient.stopServer();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const cliArgs = new Set(process.argv.slice(2));
  const chatEnabledByEnv = process.env.TERMINAL_CHAT !== "false";
  const shouldStartChat = cliArgs.has("--chat") && !cliArgs.has("--no-chat") && chatEnabledByEnv;

  if (shouldStartChat) {
    await startTerminalChat({
      agentService,
      workspace,
      shutdown,
      syncSkills,
      updateCommandService
    });
  }
};
