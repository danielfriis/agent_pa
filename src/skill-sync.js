import fs from "node:fs/promises";
import path from "node:path";

import { toAbsolutePath } from "./path-utils.js";

const MANAGED_SKILL_PREFIX = "agent-config-";

const normalizeSkillSlug = (fileName) =>
  fileName
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const ensureTrailingNewline = (text) => (text.endsWith("\n") ? text : `${text}\n`);

const removeDirIfEmpty = async (dirPath) => {
  try {
    await fs.rmdir(dirPath);
  } catch (error) {
    if (!error || typeof error !== "object") throw error;
    if (error.code === "ENOENT" || error.code === "ENOTEMPTY") return;
    throw error;
  }
};

export const syncAgentConfigSkillsToOpenCode = async ({
  agentConfigSkillsDir,
  opencodeDirectory
}) => {
  const skillsDir = toAbsolutePath(agentConfigSkillsDir);
  const opencodeDir = toAbsolutePath(opencodeDirectory);
  const opencodeConfigDir = path.join(opencodeDir, ".opencode");
  const targetDir = path.join(opencodeDir, ".opencode", "skills");
  const legacyTargetDir = path.join(opencodeDir, ".opencode", "skill");
  const legacyNamespaceDir = path.join(legacyTargetDir, "_agent-config");

  await fs.mkdir(skillsDir, { recursive: true });

  const sourceEntries = await fs.readdir(skillsDir, { withFileTypes: true });
  const markdownFiles = sourceEntries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md")
  );

  const expectedSkillDirs = new Set();
  let syncedCount = 0;

  if (markdownFiles.length > 0) {
    await fs.mkdir(targetDir, { recursive: true });
  }

  for (const entry of markdownFiles) {
    const slug = normalizeSkillSlug(entry.name);
    if (!slug) continue;
    const folderName = `${MANAGED_SKILL_PREFIX}${slug}`;
    expectedSkillDirs.add(folderName);

    const sourceFilePath = path.join(skillsDir, entry.name);
    const targetSkillDir = path.join(targetDir, folderName);
    const targetSkillFile = path.join(targetSkillDir, "SKILL.md");
    const relativeSource = path.relative(opencodeDir, sourceFilePath);

    const sourceContent = await fs.readFile(sourceFilePath, "utf8");
    const header = `<!-- Synced from ${relativeSource} -->\n`;
    const output = `${header}${ensureTrailingNewline(sourceContent)}`;

    await fs.mkdir(targetSkillDir, { recursive: true });
    await fs.writeFile(targetSkillFile, output, "utf8");
    syncedCount += 1;
  }

  let existingTargetEntries = [];
  try {
    existingTargetEntries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  let removedCount = 0;

  for (const entry of existingTargetEntries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(MANAGED_SKILL_PREFIX)) continue;
    if (expectedSkillDirs.has(entry.name)) continue;
    await fs.rm(path.join(targetDir, entry.name), { recursive: true, force: true });
    removedCount += 1;
  }

  let existingLegacyEntries = [];
  try {
    existingLegacyEntries = await fs.readdir(legacyTargetDir, { withFileTypes: true });
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  for (const entry of existingLegacyEntries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(MANAGED_SKILL_PREFIX)) continue;
    await fs.rm(path.join(legacyTargetDir, entry.name), { recursive: true, force: true });
    removedCount += 1;
  }

  // Cleanup old nested namespace from earlier sync implementation.
  await fs.rm(legacyNamespaceDir, { recursive: true, force: true });
  await removeDirIfEmpty(targetDir);
  await removeDirIfEmpty(legacyTargetDir);
  await removeDirIfEmpty(opencodeConfigDir);

  return {
    syncedCount,
    removedCount,
    sourceDir: skillsDir,
    targetDir
  };
};
