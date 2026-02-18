import fs from "node:fs/promises";
import path from "node:path";

import { readJsonBody, sendJson, sendRaw } from "./http-utils.js";

const DOWNLOAD_ROUTE = "/workspace/download";
const DOWNLOAD_LINK_ROUTE = "/workspace/download-link";
const DOWNLOAD_PATH_PARAM = "path";

const normalizeRelativePath = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed)) return null;

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
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

const resolveWorkspaceFile = async ({ workspaceRoot, requestedPath }) => {
  const relativePath = normalizeRelativePath(requestedPath);
  if (!relativePath) {
    return {
      ok: false,
      status: 400,
      error: "Body/query field `path` must be a non-empty workspace-relative file path."
    };
  }

  const workspaceRootReal = await resolveRealPath(workspaceRoot);
  const candidatePath = path.resolve(workspaceRootReal, relativePath);
  let stats;
  try {
    stats = await fs.stat(candidatePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        ok: false,
        status: 404,
        error: `File not found in workspace: ${relativePath}`
      };
    }
    throw error;
  }

  if (!stats.isFile()) {
    return {
      ok: false,
      status: 400,
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
      status: 400,
      error: "Path resolves outside of the workspace directory."
    };
  }

  return {
    ok: true,
    relativePath,
    filePath: candidateReal,
    fileName: path.basename(candidateReal),
    size: stats.size
  };
};

const encodeDownloadFileName = (fileName) =>
  encodeURIComponent(String(fileName || "")).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );

const safeAsciiFileName = (fileName) => String(fileName || "download").replace(/["\\]/g, "_");

const pickForwardedValue = (value) => String(value || "").split(",")[0].trim();

const buildBaseUrl = (req, { host: appHost, port: appPort }) => {
  const host =
    pickForwardedValue(req.headers["x-forwarded-host"]) ||
    req.headers.host ||
    `${appHost}:${appPort}`;
  const protocol =
    pickForwardedValue(req.headers["x-forwarded-proto"]) ||
    (req.socket?.encrypted ? "https" : "http");
  return `${protocol}://${host}`;
};

const buildDownloadPath = (relativePath) =>
  `${DOWNLOAD_ROUTE}?${DOWNLOAD_PATH_PARAM}=${encodeURIComponent(relativePath)}`;

export const createWorkspaceRouteHandler = ({ config }) => {
  const workspaceDir = config.opencode?.directory || config.agent.workspaceDir;
  const appSettings = config.app || { host: "127.0.0.1", port: 8787 };

  return async (req, res, pathName, requestUrl) => {
    if (req.method === "GET" && pathName === "/workspace") {
      sendJson(res, 200, {
        workspaceDir: config.agent.workspaceDir,
        opencodeDirectory: workspaceDir
      });
      return true;
    }

    if (req.method === "POST" && pathName === DOWNLOAD_LINK_ROUTE) {
      const body = await readJsonBody(req);
      const resolved = await resolveWorkspaceFile({
        workspaceRoot: workspaceDir,
        requestedPath: body.path
      });
      if (!resolved.ok) {
        sendJson(res, resolved.status, { ok: false, error: resolved.error });
        return true;
      }

      const downloadPath = buildDownloadPath(resolved.relativePath);
      sendJson(res, 200, {
        ok: true,
        path: resolved.relativePath,
        fileName: resolved.fileName,
        size: resolved.size,
        downloadPath,
        downloadUrl: `${buildBaseUrl(req, appSettings)}${downloadPath}`
      });
      return true;
    }

    if (req.method === "GET" && pathName === DOWNLOAD_ROUTE) {
      const requestedPath = requestUrl.searchParams.get(DOWNLOAD_PATH_PARAM);
      const resolved = await resolveWorkspaceFile({
        workspaceRoot: workspaceDir,
        requestedPath
      });
      if (!resolved.ok) {
        sendJson(res, resolved.status, { ok: false, error: resolved.error });
        return true;
      }

      const fileBytes = await fs.readFile(resolved.filePath);
      sendRaw(res, 200, fileBytes, {
        contentType: "application/octet-stream",
        headers: {
          "content-length": String(fileBytes.byteLength),
          "content-disposition": `attachment; filename="${safeAsciiFileName(
            resolved.fileName
          )}"; filename*=UTF-8''${encodeDownloadFileName(resolved.fileName)}`
        }
      });
      return true;
    }

    return false;
  };
};
