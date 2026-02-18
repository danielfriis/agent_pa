import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const toAbsolutePath = (value) =>
  path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);

const resolveWorkspaceDir = () =>
  toAbsolutePath(process.env.OPENCODE_DIRECTORY || process.env.AGENT_WORKSPACE_DIR || "agent_workspace");

const resolveApiBaseUrl = () => {
  const explicit = String(process.env.APP_PUBLIC_BASE_URL || process.env.AGENT_APP_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = process.env.APP_HOST || "127.0.0.1";
  const port = process.env.APP_PORT || "8787";
  return `http://${host}:${port}`;
};

const normalizeRelativePath = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.includes("\0")) return "";
  if (path.isAbsolute(trimmed)) return "";

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return "";
  }

  return normalized;
};

const resolveRealPath = async (targetPath) => {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return path.resolve(targetPath);
    }
    throw error;
  }
};

const resolveWorkspaceFile = async (workspaceDir, rawPath) => {
  const relativePath = normalizeRelativePath(rawPath);
  if (!relativePath) {
    return {
      ok: false,
      error: "Invalid `path`. Provide a non-empty workspace-relative file path."
    };
  }

  const workspaceRootReal = await resolveRealPath(workspaceDir);
  const candidatePath = path.resolve(workspaceRootReal, relativePath);
  let stats;
  try {
    stats = await fs.stat(candidatePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        ok: false,
        error: `File not found in workspace: ${relativePath}`
      };
    }
    throw error;
  }

  if (!stats.isFile()) {
    return {
      ok: false,
      error: `Path is not a file: ${relativePath}`
    };
  }

  const candidateReal = await fs.realpath(candidatePath);
  const allowedPrefix = workspaceRootReal.endsWith(path.sep)
    ? workspaceRootReal
    : `${workspaceRootReal}${path.sep}`;
  if (candidateReal !== workspaceRootReal && !candidateReal.startsWith(allowedPrefix)) {
    return {
      ok: false,
      error: "Path resolves outside of the workspace directory."
    };
  }

  return {
    ok: true,
    relativePath,
    fileName: path.basename(candidateReal),
    size: stats.size
  };
};

const buildDownloadPath = (relativePath) => `/workspace/download?path=${encodeURIComponent(relativePath)}`;

export default tool({
  description:
    "Create a validated download link for a file in the workspace directory.",
  args: {
    path: tool.schema
      .string()
      .min(1)
      .describe("Workspace-relative path of the file to download (for example: reports/output.csv)")
  },
  execute: async (args) => {
    try {
      const workspaceDir = resolveWorkspaceDir();
      const resolved = await resolveWorkspaceFile(workspaceDir, args?.path);
      if (!resolved.ok) {
        return JSON.stringify({
          ok: false,
          error: resolved.error
        });
      }

      const downloadPath = buildDownloadPath(resolved.relativePath);
      return JSON.stringify({
        ok: true,
        path: resolved.relativePath,
        fileName: resolved.fileName,
        size: resolved.size,
        workspaceDir,
        downloadPath,
        downloadUrl: `${resolveApiBaseUrl()}${downloadPath}`
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
});
