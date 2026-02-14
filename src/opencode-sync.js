import fs from "node:fs/promises";
import path from "node:path";

import { toAbsolutePath } from "./path-utils.js";

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

const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const countFilesRecursive = async (dirPath) => {
  if (!(await pathExists(dirPath))) return 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      count += 1;
      continue;
    }
    if (entry.isDirectory()) {
      count += await countFilesRecursive(entryPath);
    }
  }
  return count;
};

const syncDirectory = async ({ sourceDir, targetDir }) => {
  const absoluteSourceDir = toAbsolutePath(sourceDir);
  const absoluteTargetDir = toAbsolutePath(targetDir);
  const removedCount = await countFilesRecursive(absoluteTargetDir);

  await fs.rm(absoluteTargetDir, { recursive: true, force: true });

  if (!(await pathExists(absoluteSourceDir))) {
    return {
      syncedCount: 0,
      removedCount,
      sourceDir: absoluteSourceDir,
      targetDir: absoluteTargetDir
    };
  }

  await fs.mkdir(path.dirname(absoluteTargetDir), { recursive: true });
  await fs.cp(absoluteSourceDir, absoluteTargetDir, { recursive: true, force: true });

  return {
    syncedCount: await countFilesRecursive(absoluteTargetDir),
    removedCount,
    sourceDir: absoluteSourceDir,
    targetDir: absoluteTargetDir
  };
};

export const ensureManagedAgentTools = async (agentConfigDir) => {
  const rootDir = toAbsolutePath(agentConfigDir);
  const sourceDir = path.join(rootDir, "tools");
  const addMemoryToolFile = path.join(sourceDir, "add_memory.js");

  await fs.mkdir(sourceDir, { recursive: true });

  if (!(await pathExists(addMemoryToolFile))) {
    await fs.writeFile(addMemoryToolFile, ADD_MEMORY_TOOL_TEMPLATE, "utf8");
  }

  return {
    sourceDir,
    addMemoryToolFile
  };
};

export const syncOpenCodeTools = async ({ agentConfigDir, opencodeDirectory }) =>
  syncDirectory({
    sourceDir: path.join(toAbsolutePath(agentConfigDir), "tools"),
    targetDir: path.join(toAbsolutePath(opencodeDirectory), ".opencode", "tools")
  });

export const syncOpenCodeSkills = async ({ agentConfigDir, opencodeDirectory }) =>
  syncDirectory({
    sourceDir: path.join(toAbsolutePath(agentConfigDir), "skills"),
    targetDir: path.join(toAbsolutePath(opencodeDirectory), ".opencode", "skills")
  });

export const syncOpenCodeConfig = async ({ agentConfigDir, opencodeDirectory }) => {
  const toolConfig = await ensureManagedAgentTools(agentConfigDir);
  const toolSync = await syncOpenCodeTools({ agentConfigDir, opencodeDirectory });
  const skillSync = await syncOpenCodeSkills({ agentConfigDir, opencodeDirectory });

  return {
    toolConfig,
    toolSync,
    skillSync
  };
};
