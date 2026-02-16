import { readFormBody, sendJson, sendRaw } from "./http-utils.js";

export const createSmsRouteHandler = ({ smsChannelService }) => async (
  req,
  res,
  path,
  url
) => {
  if (!smsChannelService?.isEnabled()) return false;

  const inboundPath = smsChannelService.inboundPath();
  if (path !== inboundPath) return false;

  if (req.method !== "POST") {
    sendJson(
      res,
      405,
      { ok: false, error: "Method not allowed." },
      {
        allow: "POST"
      }
    );
    return true;
  }

  const form = await readFormBody(req);
  const outcome = await smsChannelService.handleInboundWebhook({
    headers: req.headers,
    form,
    path,
    queryString: url.search || ""
  });

  if (!outcome.ok) {
    sendJson(res, outcome.status || 400, {
      ok: false,
      error: outcome.error || "SMS inbound request failed."
    });
    return true;
  }

  sendRaw(res, outcome.status || 200, outcome.response?.body || "", {
    contentType: outcome.response?.contentType || "text/plain; charset=utf-8"
  });
  return true;
};
