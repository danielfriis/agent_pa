import fs from "node:fs/promises";
import path from "node:path";

const SKILL_TEMPLATE = `# Skill Name

## Purpose
Describe when this skill should be used.

## Inputs
- Required input(s)
- Optional context

## Steps
1. Step one
2. Step two
3. Step three

## Output
Define expected output shape.
`;

const safeSkillName = (name) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const isErrorCode = (error, code) =>
  Boolean(error && typeof error === "object" && error.code === code);

const listMarkdownFiles = async (dirPath) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
};

const hasSkillEntry = async (entryPath) => {
  try {
    const entries = await fs.readdir(entryPath, { withFileTypes: true });
    return entries.some(
      (entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md"
    );
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
};

const listSkillNames = async (dirPath) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        names.push(entry.name);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const hasSkillFile = await hasSkillEntry(path.join(dirPath, entry.name));
      if (hasSkillFile) names.push(entry.name);
    }
    return names;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    throw error;
  }
};

export class AgentWorkspace {
  constructor(optionsOrRootDir, memoryMaxChars = 6000) {
    if (typeof optionsOrRootDir === "string") {
      // Backward compatibility for legacy callsites/tests that passed only one root directory.
      this.stateDir = optionsOrRootDir;
      this.defaultsDir = optionsOrRootDir;
      this.memoryMaxChars = memoryMaxChars;
    } else {
      const options = optionsOrRootDir || {};
      this.stateDir = options.stateDir || options.rootDir || process.cwd();
      this.defaultsDir = options.defaultsDir || this.stateDir;
      this.memoryMaxChars =
        Number.isInteger(options.memoryMaxChars) && options.memoryMaxChars > 0
          ? options.memoryMaxChars
          : memoryMaxChars;
    }

    this.rootDir = this.stateDir;
    this.memoryDir = path.join(this.stateDir, "memory");
    this.stateSkillsDir = path.join(this.stateDir, "skills");
    this.defaultsSkillsDir = path.join(this.defaultsDir, "skills");
    this.stateSystemDir = path.join(this.stateDir, "system");
    this.defaultsSystemDir = path.join(this.defaultsDir, "system");
    this.sessionsDir = path.join(this.stateDir, "sessions");
    this.memoryFile = path.join(this.memoryDir, "memory.md");
    this.systemPromptFile = path.join(this.stateSystemDir, "system-prompt.md");
    this.skillsDir = this.stateSkillsDir;
    this.systemDir = this.stateSystemDir;
  }

  async ensure() {
    await Promise.all([
      fs.mkdir(this.defaultsDir, { recursive: true }),
      fs.mkdir(this.stateDir, { recursive: true }),
      fs.mkdir(this.defaultsSkillsDir, { recursive: true }),
      fs.mkdir(this.defaultsSystemDir, { recursive: true }),
      fs.mkdir(this.memoryDir, { recursive: true }),
      fs.mkdir(this.stateSkillsDir, { recursive: true }),
      fs.mkdir(this.stateSystemDir, { recursive: true }),
      fs.mkdir(this.sessionsDir, { recursive: true })
    ]);

    try {
      await fs.access(this.memoryFile);
    } catch {
      await fs.writeFile(
        this.memoryFile,
        "# Agent Memory\n\nUse `/remember ...` in terminal chat to append persistent memory.\n",
        "utf8"
      );
    }

    try {
      await fs.access(this.systemPromptFile);
    } catch {
      await fs.writeFile(this.systemPromptFile, "", "utf8");
    }
  }

  summary() {
    return {
      rootDir: this.rootDir,
      defaultsDir: this.defaultsDir,
      stateDir: this.stateDir,
      memoryFile: this.memoryFile,
      systemPromptFile: this.systemPromptFile,
      skillsDir: this.stateSkillsDir,
      defaultsSkillsDir: this.defaultsSkillsDir,
      stateSkillsDir: this.stateSkillsDir,
      defaultsSystemDir: this.defaultsSystemDir,
      stateSystemDir: this.stateSystemDir,
      sessionsDir: this.sessionsDir
    };
  }

  async readMemory() {
    try {
      return await fs.readFile(this.memoryFile, "utf8");
    } catch {
      return "";
    }
  }

  async readMemoryForPrompt() {
    const memory = await this.readMemory();
    if (!memory.trim()) return "";
    return memory.slice(-this.memoryMaxChars);
  }

  async appendMemory(text) {
    const line = `- ${new Date().toISOString()}: ${text.trim()}\n`;
    await fs.appendFile(this.memoryFile, line, "utf8");
  }

  async readSystemPrompt() {
    const layeredFiles = new Map();
    const defaultsMarkdownFiles = await listMarkdownFiles(this.defaultsSystemDir);
    const stateMarkdownFiles = await listMarkdownFiles(this.stateSystemDir);

    for (const name of defaultsMarkdownFiles) {
      layeredFiles.set(name, path.join(this.defaultsSystemDir, name));
    }
    for (const name of stateMarkdownFiles) {
      layeredFiles.set(name, path.join(this.stateSystemDir, name));
    }

    const sortedNames = [...layeredFiles.keys()].sort((a, b) => a.localeCompare(b));
    if (!sortedNames.length) return "";

    const contents = await Promise.all(
      sortedNames.map((name) => fs.readFile(layeredFiles.get(name), "utf8"))
    );
    return contents
      .map((content) => content.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  async writeSystemPrompt(text) {
    const normalized = typeof text === "string" ? text : "";
    const final = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    await fs.writeFile(this.systemPromptFile, final, "utf8");
  }

  async listSkills() {
    const layered = new Map();
    for (const name of await listSkillNames(this.defaultsSkillsDir)) {
      layered.set(name, "default");
    }
    for (const name of await listSkillNames(this.stateSkillsDir)) {
      layered.set(name, "state");
    }
    return [...layered.keys()].sort((a, b) => a.localeCompare(b));
  }

  async createSkill(name) {
    const cleaned = safeSkillName(name || "");
    if (!cleaned) {
      throw new Error("Skill name is empty after sanitization.");
    }
    const fileName = cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
    const filePath = path.join(this.stateSkillsDir, fileName);
    await fs.writeFile(filePath, SKILL_TEMPLATE, { encoding: "utf8", flag: "wx" });
    return filePath;
  }
}
