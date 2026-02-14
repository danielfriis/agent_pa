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
import { SessionStore } from "./session-store.js";
import { AgentWorkspace } from "./workspace.js";

export const main = async () => {
  // Ensure child processes (OpenCode + tools) receive absolute workspace/config paths.
  process.env.AGENT_CONFIG_DIR = config.agent.configDir;
  process.env.AGENT_WORKSPACE_DIR = config.agent.workspaceDir;
  process.env.OPENCODE_DIRECTORY = config.opencode.directory;

  const opencodeClient = new OpenCodeClient(config.opencode);
  const workspace = new AgentWorkspace(config.workspace.rootDir, config.workspace.memoryMaxChars);
  const sessionStore = new SessionStore(config.sessionStore);
  const withMemorySystem = createMemorySystemInjector(workspace);
  const agentService = createAgentService({
    opencodeClient,
    sessionStore,
    withMemorySystem
  });

  await fs.mkdir(config.agent.workspaceDir, { recursive: true });
  await workspace.ensure();
  await sessionStore.ensure();

  const openCodeSync = await syncOpenCodeConfig({
    agentConfigDir: config.agent.configDir,
    opencodeDirectory: config.opencode.directory
  });
  process.stdout.write(
    `[agent-pa] tool sync: ${openCodeSync.toolSync.syncedCount} file(s), ${openCodeSync.toolSync.removedCount} removed (${openCodeSync.toolSync.targetDir})\n`
  );
  process.stdout.write(`[agent-pa] tool config dir: ${openCodeSync.toolConfig.sourceDir}\n`);

  const syncSkills = () =>
    syncOpenCodeSkills({
      agentConfigDir: config.agent.configDir,
      opencodeDirectory: config.opencode.directory
    });

  const skillSync = await syncSkills();
  process.stdout.write(
    `[agent-pa] skill sync: ${skillSync.syncedCount} file(s), ${skillSync.removedCount} removed (${skillSync.targetDir})\n`
  );

  await opencodeClient.startServerIfConfigured();

  const route = createRouteHandler({
    opencodeClient,
    sessionStore,
    workspace,
    config,
    withMemorySystem
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
      syncSkills
    });
  }
};
