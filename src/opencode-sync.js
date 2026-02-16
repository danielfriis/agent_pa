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

const FETCH_WEBPAGE_TOOL_TEMPLATE = `import { tool } from "@opencode-ai/plugin";

const DEFAULT_MAX_CHARS = 15000;
const REQUEST_TIMEOUT_MS = 20000;

const BLOCKED_TEXT_PATTERNS = [
  "enable javascript",
  "javascript is required",
  "access denied",
  "forbidden",
  "cloudflare",
  "bot detection",
  "captcha",
  "request blocked",
  "attention required"
];

const cleanWhitespace = (value) =>
  String(value || "")
    .replace(/\\r\\n?/g, "\\n")
    .replace(/\\u00a0/g, " ")
    .replace(/[ \\t]+\\n/g, "\\n")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();

const truncate = (value, maxChars) => {
  const text = cleanWhitespace(value);
  if (!text) return "";
  if (!maxChars || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return \`\${text.slice(0, maxChars - 3)}...\`;
};

const normalizeUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\\/\\//i.test(raw) ? raw : \`https://\${raw}\`;
  try {
    const parsed = new URL(withScheme);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
};

const toJinaMirrorUrl = (url) => \`https://r.jina.ai/\${url}\`;

const decodeHtmlEntities = (value) =>
  String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

const extractTitle = (value) => {
  const match = String(value || "").match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);
  if (!match) return "";
  return cleanWhitespace(decodeHtmlEntities(match[1]));
};

const htmlToText = (value) => {
  const raw = String(value || "");
  if (!raw) return "";
  return cleanWhitespace(
    decodeHtmlEntities(
      raw
        .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
        .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
        .replace(/<noscript[\\s\\S]*?<\\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );
};

const isLikelyHtml = ({ contentType, body }) =>
  String(contentType || "")
    .toLowerCase()
    .includes("html") ||
  /^\\s*</.test(String(body || ""));

const isBlocked = ({ status, body }) => {
  if (typeof status === "number" && status >= 400) return true;
  const text = String(body || "").toLowerCase();
  if (!text.trim()) return true;
  return BLOCKED_TEXT_PATTERNS.some((pattern) => text.includes(pattern));
};

const fetchWithTimeout = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; agent-pa-fetch-webpage/1.0; +https://github.com/anomalyco/opencode)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7"
      },
      signal: controller.signal
    });
    const body = await response.text();
    return {
      ok: true,
      url,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      body
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
};

const buildSuccess = ({ requestedUrl, result, strategy }) => {
  const html = isLikelyHtml(result);
  const title = html ? extractTitle(result.body) : "";
  const text = html ? htmlToText(result.body) : cleanWhitespace(result.body);
  const truncated = truncate(text, DEFAULT_MAX_CHARS);
  if (!truncated) {
    return {
      ok: false,
      error: "Fetched response contained no readable text.",
      requestedUrl,
      fetchedUrl: result.url,
      strategy,
      status: result.status
    };
  }

  return {
    ok: true,
    requestedUrl,
    fetchedUrl: result.url,
    strategy,
    status: result.status,
    contentType: result.contentType,
    title,
    text: truncated
  };
};

export default tool({
  description:
    "Fetch readable webpage text with fallback for JS-heavy or bot-protected pages. Use this when direct browsing fails with 403/empty/JS-required responses.",
  args: {
    url: tool.schema.string().min(1).describe("URL to fetch.")
  },
  execute: async (args) => {
    try {
      const requestedUrl = normalizeUrl(args?.url);
      if (!requestedUrl) {
        return JSON.stringify({
          ok: false,
          error: "Invalid URL. Provide a full HTTP(S) URL."
        });
      }

      const direct = await fetchWithTimeout(requestedUrl);
      if (direct.ok && !isBlocked(direct)) {
        return JSON.stringify(
          buildSuccess({
            requestedUrl,
            result: direct,
            strategy: "direct"
          })
        );
      }

      const mirrorUrl = toJinaMirrorUrl(requestedUrl);
      const mirrored = await fetchWithTimeout(mirrorUrl);
      if (mirrored.ok && !isBlocked(mirrored)) {
        return JSON.stringify(
          buildSuccess({
            requestedUrl,
            result: mirrored,
            strategy: "jina-mirror"
          })
        );
      }

      if (direct.ok) {
        return JSON.stringify(
          buildSuccess({
            requestedUrl,
            result: direct,
            strategy: "direct-fallback"
          })
        );
      }

      if (mirrored.ok) {
        return JSON.stringify(
          buildSuccess({
            requestedUrl,
            result: mirrored,
            strategy: "jina-mirror-fallback"
          })
        );
      }

      return JSON.stringify({
        ok: false,
        error: \`Failed to fetch URL directly and via mirror: \${direct.error || mirrored.error || "unknown error"}\`,
        requestedUrl
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
  const fetchWebpageToolFile = path.join(sourceDir, "fetch_webpage.js");

  await fs.mkdir(sourceDir, { recursive: true });

  if (!(await pathExists(addMemoryToolFile))) {
    await fs.writeFile(addMemoryToolFile, ADD_MEMORY_TOOL_TEMPLATE, "utf8");
  }
  if (!(await pathExists(fetchWebpageToolFile))) {
    await fs.writeFile(fetchWebpageToolFile, FETCH_WEBPAGE_TOOL_TEMPLATE, "utf8");
  }

  return {
    sourceDir,
    addMemoryToolFile,
    fetchWebpageToolFile
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
