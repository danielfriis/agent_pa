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

export class AgentWorkspace {
  constructor(rootDir, memoryMaxChars = 6000) {
    this.rootDir = rootDir;
    this.memoryMaxChars = memoryMaxChars;
    this.memoryDir = path.join(rootDir, "memory");
    this.skillsDir = path.join(rootDir, "skills");
    this.systemDir = path.join(rootDir, "system");
    this.sessionsDir = path.join(rootDir, "sessions");
    this.memoryFile = path.join(this.memoryDir, "memory.md");
    this.systemPromptFile = path.join(this.systemDir, "system-prompt.md");
  }

  async ensure() {
    await Promise.all([
      fs.mkdir(this.rootDir, { recursive: true }),
      fs.mkdir(this.memoryDir, { recursive: true }),
      fs.mkdir(this.skillsDir, { recursive: true }),
      fs.mkdir(this.systemDir, { recursive: true }),
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
      memoryFile: this.memoryFile,
      systemPromptFile: this.systemPromptFile,
      skillsDir: this.skillsDir,
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
    try {
      return await fs.readFile(this.systemPromptFile, "utf8");
    } catch {
      return "";
    }
  }

  async writeSystemPrompt(text) {
    const normalized = typeof text === "string" ? text : "";
    const final = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    await fs.writeFile(this.systemPromptFile, final, "utf8");
  }

  async listSkills() {
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    const names = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        names.push(entry.name);
        continue;
      }

      if (!entry.isDirectory()) continue;
      const skillDir = path.join(this.skillsDir, entry.name);
      const skillDirEntries = await fs.readdir(skillDir, { withFileTypes: true });
      const hasSkillFile = skillDirEntries.some(
        (skillEntry) => skillEntry.isFile() && skillEntry.name.toLowerCase() === "skill.md"
      );
      if (hasSkillFile) {
        names.push(entry.name);
      }
    }

    return names.sort((a, b) => a.localeCompare(b));
  }

  async createSkill(name) {
    const cleaned = safeSkillName(name || "");
    if (!cleaned) {
      throw new Error("Skill name is empty after sanitization.");
    }
    const fileName = cleaned.endsWith(".md") ? cleaned : `${cleaned}.md`;
    const filePath = path.join(this.skillsDir, fileName);
    await fs.writeFile(filePath, SKILL_TEMPLATE, { encoding: "utf8", flag: "wx" });
    return filePath;
  }
}
