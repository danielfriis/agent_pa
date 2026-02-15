import { URL } from "node:url";

import { isRequestAuthorized } from "./auth.js";
import { sendJson, sendNoContent } from "./http-utils.js";
import { createSessionRouteHandler } from "./session-routes.js";
import { createWorkspaceRouteHandler } from "./workspace-routes.js";

export const createRouteHandler = ({
  opencodeClient,
  workspace,
  config,
  agentService
}) => {
  const handleSessionRoute = createSessionRouteHandler({ agentService });

  const handleWorkspaceRoute = createWorkspaceRouteHandler({
    workspace,
    agentWorkspaceDir: config.agent.workspaceDir,
    memoryPreviewChars: config.memory.maxChars
  });

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
    const requiresAuth =
      config.security?.requireAuth &&
      (!isHealthRoute || !config.security.allowUnauthenticatedHealth);

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

      if (await handleSessionRoute(req, res, path)) return;
      if (await handleWorkspaceRoute(req, res, path)) return;

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail === "Invalid JSON body") {
        sendJson(res, 400, { error: detail });
        return;
      }

      sendJson(res, 500, {
        error: "Request failed",
        detail
      });
    }
  };
};
