import { URL } from "node:url";

import { isRequestAuthorized } from "./auth.js";
import { sendJson, sendNoContent } from "./http-utils.js";
import { createSessionRouteHandler } from "./session-routes.js";
import { createSmsRouteHandler } from "./sms-routes.js";
import { createStateRouteHandler } from "./state-routes.js";

const normalizeRoutePath = (value) => {
  const raw = String(value || "/").trim();
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/, "") || "/";
};

export const createRouteHandler = ({
  opencodeClient,
  workspace,
  config,
  agentService,
  smsChannelService,
  updateCommandService
}) => {
  const handleSessionRoute = createSessionRouteHandler({
    agentService,
    updateCommandService
  });

  const handleStateRoute = createStateRouteHandler({
    workspace,
    memoryPreviewChars: config.memory.maxChars
  });
  const handleSmsRoute = createSmsRouteHandler({ smsChannelService });

  return async (req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: "Missing URL" });
      return;
    }

    if (req.method === "OPTIONS") {
      sendNoContent(res);
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    const isHealthRoute = req.method === "GET" && path === "/health";
    const configuredSmsInboundPath =
      smsChannelService?.isEnabled() ? normalizeRoutePath(smsChannelService.inboundPath()) : null;
    const isSmsInboundRoute =
      req.method === "POST" &&
      configuredSmsInboundPath &&
      normalizeRoutePath(path) === configuredSmsInboundPath;
    const requiresAuth =
      config.security?.requireAuth &&
      (!isHealthRoute || !config.security.allowUnauthenticatedHealth) &&
      !(isSmsInboundRoute && config.channels?.sms?.allowUnauthenticatedInbound);

    if (requiresAuth && !isRequestAuthorized(req.headers, config.security)) {
      sendJson(
        res,
        401,
        { ok: false, error: "Unauthorized" },
        {
          "www-authenticate": "Bearer"
        }
      );
      return;
    }

    try {
      if (isHealthRoute) {
        let appInfo = null;
        let opencodeStatus = "ok";
        let opencodeError = null;

        try {
          appInfo = await opencodeClient.health();
        } catch (error) {
          opencodeStatus = "unavailable";
          opencodeError = error instanceof Error ? error.message : String(error);
        }

        sendJson(res, 200, {
          ok: opencodeStatus === "ok",
          app: "agent-pa",
          opencode: {
            status: opencodeStatus,
            info: appInfo,
            error: opencodeError
          }
        });
        return;
      }

      if (req.method === "GET" && path === "/events") {
        await opencodeClient.pipeGlobalEvents(res);
        return;
      }

      if (req.method === "GET" && path === "/workspace") {
        sendJson(res, 200, {
          workspaceDir: config.agent.workspaceDir,
          opencodeDirectory: config.opencode?.directory || config.agent.workspaceDir
        });
        return;
      }

      if (await handleSessionRoute(req, res, path)) return;
      if (await handleStateRoute(req, res, path)) return;
      if (await handleSmsRoute(req, res, path, url)) return;

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === "Invalid JSON body") {
        sendJson(res, 400, { error: detail });
        return;
      }
      if (detail.includes("timed out")) {
        sendJson(res, 504, {
          error: "Request timed out",
          detail
        });
        return;
      }

      sendJson(res, 500, {
        error: "Request failed",
        detail
      });
    }
  };
};
