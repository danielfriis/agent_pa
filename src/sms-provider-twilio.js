import { createHmac, timingSafeEqual } from "node:crypto";

const asArray = (value) => (Array.isArray(value) ? value : [value]);

const first = (value) => {
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
};

const normalizeEndpoint = (value) => String(value || "").trim().replace(/\s+/g, "").toLowerCase();

const timingSafeStringEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const escapeXml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const flattenParams = (params) => {
  const output = {};
  for (const [key, value] of Object.entries(params || {})) {
    output[key] = asArray(value).map((item) => String(item || ""));
  }
  return output;
};

const sleep = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const buildTwilioSignaturePayload = (signatureUrl, params) => {
  let payload = signatureUrl;
  for (const key of Object.keys(params).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const value of [...params[key]].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      payload += `${key}${value}`;
    }
  }
  return payload;
};

const computeTwilioSignature = ({ authToken, signatureUrl, form }) =>
  createHmac("sha1", authToken)
    .update(buildTwilioSignaturePayload(signatureUrl, flattenParams(form)), "utf8")
    .digest("base64");

export const createTwilioSmsAdapter = (twilioConfig = {}) => {
  const allowedToSet = new Set(
    (twilioConfig.allowedToNumbers || []).map(normalizeEndpoint).filter(Boolean)
  );
  const allowedFromSet = new Set(
    (twilioConfig.allowedFromNumbers || []).map(normalizeEndpoint).filter(Boolean)
  );

  const resolveAuthToken = (accountSid) => {
    if (
      accountSid &&
      twilioConfig.authTokensByAccountSid &&
      typeof twilioConfig.authTokensByAccountSid[accountSid] === "string"
    ) {
      return twilioConfig.authTokensByAccountSid[accountSid];
    }
    return twilioConfig.authToken || "";
  };

  const parseInbound = (form = {}) => {
    const from = first(form.From).trim();
    const to = first(form.To).trim();
    if (!from || !to) {
      return {
        ok: false,
        status: 400,
        error: "Twilio payload must include both `From` and `To`."
      };
    }

    return {
      ok: true,
      event: {
        provider: "twilio",
        accountId: first(form.AccountSid).trim(),
        messageId: first(form.MessageSid).trim(),
        from,
        to,
        text: first(form.Body).trim()
      }
    };
  };

  const verifyRequest = ({ headers = {}, form = {}, signatureUrl }) => {
    if (!twilioConfig.validateSignature) {
      return { ok: true };
    }

    const accountSid = first(form.AccountSid).trim();
    const authToken = resolveAuthToken(accountSid);
    if (!authToken) {
      return {
        ok: false,
        status: 500,
        error: "Twilio signature validation is enabled but no matching auth token is configured."
      };
    }

    const providedSignature = first(headers["x-twilio-signature"]).trim();
    if (!providedSignature) {
      return {
        ok: false,
        status: 403,
        error: "Missing `x-twilio-signature` header."
      };
    }

    const expectedSignature = computeTwilioSignature({
      authToken,
      signatureUrl,
      form
    });
    if (!timingSafeStringEqual(expectedSignature, providedSignature)) {
      return {
        ok: false,
        status: 403,
        error: "Invalid Twilio signature."
      };
    }

    return { ok: true };
  };

  const isAllowedDestination = (to) => {
    if (!allowedToSet.size) return true;
    return allowedToSet.has(normalizeEndpoint(to));
  };

  const isAllowedSender = (from) => {
    if (!allowedFromSet.size) return true;
    return allowedFromSet.has(normalizeEndpoint(from));
  };

  const formatReply = (texts) => {
    const messages = asArray(texts)
      .map((text) => String(text ?? ""))
      .filter((text) => text.length > 0);
    if (!messages.length) {
      return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
    }
    const xmlMessages = messages.map((text) => `<Message>${escapeXml(text)}</Message>`).join("");
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${xmlMessages}</Response>`;
  };

  const sendReply = async ({ event, texts, delayMs = 0 }) => {
    const messages = asArray(texts)
      .map((text) => String(text ?? ""))
      .filter((text) => text.length > 0);
    if (!messages.length) {
      return {
        ok: true,
        sentCount: 0,
        messageIds: []
      };
    }

    const accountId = first(event?.accountId).trim();
    const from = first(event?.to).trim();
    const to = first(event?.from).trim();
    if (!accountId || !from || !to) {
      return {
        ok: false,
        status: 400,
        sentCount: 0,
        error: "Twilio outbound send requires accountId, to, and from values."
      };
    }

    const authToken = resolveAuthToken(accountId);
    if (!authToken) {
      return {
        ok: false,
        status: 500,
        sentCount: 0,
        error: "Twilio outbound send failed: no auth token configured for account."
      };
    }

    const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountId)}/Messages.json`;
    const authHeader = `Basic ${Buffer.from(`${accountId}:${authToken}`, "utf8").toString("base64")}`;
    const messageIds = [];
    let sentCount = 0;

    for (const message of messages) {
      const form = new URLSearchParams();
      form.set("From", from);
      form.set("To", to);
      form.set("Body", message);

      let response;
      try {
        response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: authHeader
          },
          body: form.toString()
        });
      } catch (error) {
        return {
          ok: false,
          status: 502,
          sentCount,
          error: `Twilio outbound send failed: ${error instanceof Error ? error.message : String(error)}`
        };
      }

      let payload = null;
      let responseText = "";
      try {
        responseText = await response.text();
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const providerError =
          first(payload?.message).trim() ||
          first(payload?.detail).trim() ||
          responseText.trim() ||
          response.statusText ||
          "Unknown Twilio API error.";
        return {
          ok: false,
          status: response.status,
          sentCount,
          error: `Twilio outbound send failed (${response.status}): ${providerError}`
        };
      }

      const messageId = first(payload?.sid).trim();
      if (messageId) messageIds.push(messageId);
      sentCount += 1;
      if (delayMs > 0 && sentCount < messages.length) {
        await sleep(delayMs);
      }
    }

    return {
      ok: true,
      sentCount,
      messageIds
    };
  };

  return {
    provider: "twilio",
    parseInbound,
    verifyRequest,
    isAllowedDestination,
    isAllowedSender,
    formatReply,
    sendReply
  };
};

export const createTwilioSignatureUrl = ({
  webhookBaseUrl,
  path,
  queryString = "",
  headers = {}
}) => {
  if (webhookBaseUrl) {
    return new URL(`${path}${queryString}`, webhookBaseUrl).toString();
  }

  const forwardedProtoHeader = first(headers["x-forwarded-proto"]).trim();
  const forwardedHostHeader = first(headers["x-forwarded-host"]).trim();
  const hostHeader = first(headers.host).trim();
  const protocol = forwardedProtoHeader.split(",")[0].trim() || "http";
  const host = forwardedHostHeader.split(",")[0].trim() || hostHeader || "localhost";
  return `${protocol}://${host}${path}${queryString}`;
};

export const createSmsConversationKey = ({ provider, accountId, to, from }) =>
  [
    String(provider || "").toLowerCase(),
    normalizeEndpoint(accountId || "default"),
    normalizeEndpoint(to),
    normalizeEndpoint(from)
  ].join(":");
