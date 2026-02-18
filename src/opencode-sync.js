import fs from "node:fs/promises";
import path from "node:path";

import { toAbsolutePath } from "./path-utils.js";

const MANAGED_TOOL_FILENAMES = Object.freeze([
  "add_memory.js",
  "fetch_webpage.js",
  "create_download_link.js"
]);

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

const resolveLayeredPaths = ({ agentDefaultsDir, agentStateDir, agentConfigDir, kind }) => {
  const defaultsRoot = toAbsolutePath(agentDefaultsDir || agentConfigDir || "agent_defaults");
  const stateRoot = toAbsolutePath(agentStateDir || agentConfigDir || "agent_state");
  return {
    defaultsRoot,
    stateRoot,
    defaultsDir: path.join(defaultsRoot, kind),
    stateDir: path.join(stateRoot, kind),
    effectiveDir: path.join(stateRoot, "effective", kind)
  };
};

const mergeLayeredDirectory = async ({ defaultsDir, stateDir, effectiveDir }) => {
  await fs.rm(effectiveDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(effectiveDir), { recursive: true });

  if (await pathExists(defaultsDir)) {
    await fs.cp(defaultsDir, effectiveDir, { recursive: true, force: true });
  }
  if (await pathExists(stateDir)) {
    await fs.mkdir(effectiveDir, { recursive: true });
    await fs.cp(stateDir, effectiveDir, { recursive: true, force: true });
  }

  return {
    defaultsDir: toAbsolutePath(defaultsDir),
    stateDir: toAbsolutePath(stateDir),
    effectiveDir: toAbsolutePath(effectiveDir),
    mergedCount: await countFilesRecursive(effectiveDir)
  };
};

const ensureManagedToolFile = async ({ sourcePath, targetPath }) => {
  if (!(await pathExists(sourcePath))) return false;
  if (await pathExists(targetPath)) return false;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return true;
};

export const ensureManagedAgentTools = async (agentDefaultsDir) => {
  const defaultsRoot = toAbsolutePath(agentDefaultsDir || "agent_defaults");
  const sourceDir = path.join(defaultsRoot, "tools");
  await fs.mkdir(sourceDir, { recursive: true });

  const repoBuiltinToolsDir = path.resolve(process.cwd(), "agent_defaults", "tools");

  const addMemoryToolFile = path.join(sourceDir, "add_memory.js");
  const fetchWebpageToolFile = path.join(sourceDir, "fetch_webpage.js");
  const createDownloadLinkToolFile = path.join(sourceDir, "create_download_link.js");

  for (const fileName of MANAGED_TOOL_FILENAMES) {
    await ensureManagedToolFile({
      sourcePath: path.join(repoBuiltinToolsDir, fileName),
      targetPath: path.join(sourceDir, fileName)
    });
  }

  return {
    sourceDir,
    addMemoryToolFile,
    fetchWebpageToolFile,
    createDownloadLinkToolFile
  };
};

export const syncOpenCodeTools = async ({
  agentDefaultsDir,
  agentStateDir,
  agentConfigDir,
  opencodeDirectory
}) => {
  const paths = resolveLayeredPaths({
    agentDefaultsDir,
    agentStateDir,
    agentConfigDir,
    kind: "tools"
  });
  await ensureManagedAgentTools(paths.defaultsRoot);
  const merge = await mergeLayeredDirectory(paths);
  const sync = await syncDirectory({
    sourceDir: merge.effectiveDir,
    targetDir: path.join(toAbsolutePath(opencodeDirectory), ".opencode", "tools")
  });
  return {
    ...sync,
    defaultsDir: merge.defaultsDir,
    stateDir: merge.stateDir,
    effectiveDir: merge.effectiveDir
  };
};

export const syncOpenCodeSkills = async ({
  agentDefaultsDir,
  agentStateDir,
  agentConfigDir,
  opencodeDirectory
}) => {
  const paths = resolveLayeredPaths({
    agentDefaultsDir,
    agentStateDir,
    agentConfigDir,
    kind: "skills"
  });
  const merge = await mergeLayeredDirectory(paths);
  const sync = await syncDirectory({
    sourceDir: merge.effectiveDir,
    targetDir: path.join(toAbsolutePath(opencodeDirectory), ".opencode", "skills")
  });
  return {
    ...sync,
    defaultsDir: merge.defaultsDir,
    stateDir: merge.stateDir,
    effectiveDir: merge.effectiveDir
  };
};

export const syncOpenCodeConfig = async ({
  agentDefaultsDir,
  agentStateDir,
  agentConfigDir,
  opencodeDirectory
}) => {
  const defaultsRoot = toAbsolutePath(agentDefaultsDir || agentConfigDir || "agent_defaults");
  const toolConfig = await ensureManagedAgentTools(defaultsRoot);
  const toolSync = await syncOpenCodeTools({
    agentDefaultsDir,
    agentStateDir,
    agentConfigDir,
    opencodeDirectory
  });
  const skillSync = await syncOpenCodeSkills({
    agentDefaultsDir,
    agentStateDir,
    agentConfigDir,
    opencodeDirectory
  });

  return {
    toolConfig,
    toolSync,
    skillSync
  };
};
