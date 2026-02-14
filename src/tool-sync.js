import fs from "node:fs/promises";
import path from "node:path";

import { toAbsolutePath } from "./path-utils.js";

const MANAGED_TOOL_MANIFEST = ".agent-pa-managed-tools.json";

const isFsErrorCode = (error, code) =>
  Boolean(error && typeof error === "object" && error.code === code);

const removeDirIfEmpty = async (dirPath) => {
  try {
    await fs.rmdir(dirPath);
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT") || isFsErrorCode(error, "ENOTEMPTY")) return;
    throw error;
  }
};

const removeFileIfExists = async (filePath) => {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  await fs.rm(filePath, { force: true });
  return true;
};

const isJavaScriptFile = (entry) =>
  entry.isFile() && entry.name.toLowerCase().endsWith(".js");

const readManagedToolManifest = async (targetDir) => {
  const manifestPath = path.join(targetDir, MANAGED_TOOL_MANIFEST);
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((name) => typeof name === "string").sort();
  } catch (error) {
    if (isFsErrorCode(error, "ENOENT")) return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
};

const writeManagedToolManifest = async (targetDir, fileNames) => {
  const manifestPath = path.join(targetDir, MANAGED_TOOL_MANIFEST);
  if (!fileNames.length) {
    await fs.rm(manifestPath, { force: true });
    return;
  }
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(fileNames, null, 2)}\n`,
    "utf8"
  );
};

const ADD_MEMORY_TOOL_TEMPLATE = `import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const toAbsolutePath = (value) =>
  path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);

const resolveConfigDir = () => {
  const raw = process.env.AGENT_CONFIG_DIR || "agent_config";
  return toAbsolutePath(raw);
};

const resolveMemoryFile = () => path.join(resolveConfigDir(), "memory", "memory.md");

const ensureMemoryFile = async (memoryFile) => {
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  try {
    await fs.access(memoryFile);
  } catch {
    await fs.writeFile(
      memoryFile,
      "# Agent Memory\\n\\nUse add_memory to append persistent memory.\\n",
      "utf8"
    );
  }
};

export default tool({
  description: "Append a timestamped entry to persistent memory.",
  args: {
    text: tool.schema.string().min(1).describe("Memory text to persist")
  },
  execute: async (args) => {
    try {
      const text = typeof args?.text === "string" ? args.text.trim() : "";
      if (!text) {
        return JSON.stringify({
          ok: false,
          error: "Missing required argument: text"
        });
      }

      const memoryFile = resolveMemoryFile();
      await ensureMemoryFile(memoryFile);
      const line = \`- \${new Date().toISOString()}: \${text}\\n\`;
      await fs.appendFile(memoryFile, line, "utf8");
      return JSON.stringify({
        ok: true,
        memoryFile
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
});
`;

export const ensureManagedAgentTools = async (agentConfigDir) => {
  const rootDir = toAbsolutePath(agentConfigDir);
  const sourceDir = path.join(rootDir, "tools");
  const addMemoryToolFile = path.join(sourceDir, "add_memory.js");

  await fs.mkdir(sourceDir, { recursive: true });

  try {
    await fs.access(addMemoryToolFile);
  } catch {
    await fs.writeFile(addMemoryToolFile, ADD_MEMORY_TOOL_TEMPLATE, "utf8");
  }

  return {
    sourceDir,
    addMemoryToolFile
  };
};

export const syncAgentConfigToolsToOpenCode = async ({
  agentConfigDir,
  opencodeDirectory
}) => {
  const configRoot = toAbsolutePath(agentConfigDir);
  const sourceDir = path.join(configRoot, "tools");
  const workspaceRoot = toAbsolutePath(opencodeDirectory);
  const opencodeConfigDir = path.join(workspaceRoot, ".opencode");
  const targetDir = path.join(opencodeConfigDir, "tools");
  const legacyTargetDir = path.join(opencodeConfigDir, "tool");

  let sourceEntries = [];
  try {
    sourceEntries = await fs.readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (!isFsErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const sourceToolNames = sourceEntries
    .filter(isJavaScriptFile)
    .map((entry) => entry.name)
    .sort();
  const [managedInTarget, managedInLegacy] = await Promise.all([
    readManagedToolManifest(targetDir),
    readManagedToolManifest(legacyTargetDir)
  ]);
  const previouslyManagedToolNames = [...new Set([...managedInTarget, ...managedInLegacy])];
  let removedCount = 0;

  if (sourceToolNames.length || previouslyManagedToolNames.length) {
    await fs.mkdir(targetDir, { recursive: true });
  }

  for (const toolName of sourceToolNames) {
    await fs.copyFile(
      path.join(sourceDir, toolName),
      path.join(targetDir, toolName)
    );
  }

  for (const toolName of previouslyManagedToolNames) {
    if (sourceToolNames.includes(toolName)) continue;
    if (await removeFileIfExists(path.join(targetDir, toolName))) {
      removedCount += 1;
    }
  }

  for (const toolName of [...new Set([...sourceToolNames, ...managedInLegacy])]) {
    if (await removeFileIfExists(path.join(legacyTargetDir, toolName))) {
      removedCount += 1;
    }
  }

  await writeManagedToolManifest(targetDir, sourceToolNames);
  await fs.rm(path.join(legacyTargetDir, MANAGED_TOOL_MANIFEST), { force: true });
  await removeDirIfEmpty(targetDir);
  await removeDirIfEmpty(legacyTargetDir);
  await removeDirIfEmpty(opencodeConfigDir);

  return {
    syncedCount: sourceToolNames.length,
    removedCount,
    sourceDir,
    targetDir
  };
};
