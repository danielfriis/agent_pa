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

  const formatReply = (texts) => {
    const messages = asArray(texts)
      .map((text) => String(text ?? ""))
      .filter((text) => text.length > 0);
    const xmlMessages = (messages.length ? messages : [""])
      .map((text) => `<Message>${escapeXml(text)}</Message>`)
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${xmlMessages}</Response>`;
  };

  return {
    provider: "twilio",
    parseInbound,
    verifyRequest,
    isAllowedDestination,
    formatReply
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
