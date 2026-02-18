import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const toAbsolutePath = (value) =>
  path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);

const resolveStateDir = () => {
  const raw = process.env.AGENT_STATE_DIR || "agent_state";
  return toAbsolutePath(raw);
};

const resolveMemoryFile = () => path.join(resolveStateDir(), "memory", "memory.md");
const MEMORY_TEMPLATE = `# Agent Memory

Use add_memory to append persistent memory.
Memory writing rules:
- Do not use first-person references like "I", "my", "me", "we", or "our".
- Always name the actor explicitly, for example "User" or "Assistant".
- Prefer factual, role-labeled statements like "User name is Daniel.".
`;

const ensureMemoryFile = async (memoryFile) => {
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  try {
    await fs.access(memoryFile);
  } catch {
    await fs.writeFile(memoryFile, MEMORY_TEMPLATE, "utf8");
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
      const line = `- ${new Date().toISOString()}: ${text}\n`;
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
