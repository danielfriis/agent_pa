import {
  createSmsConversationKey,
  createTwilioSignatureUrl,
  createTwilioSmsAdapter
} from "./sms-provider-twilio.js";

const trimToString = (value) => String(value || "").trim();

const truncateText = (value, maxChars) => {
  const text = trimToString(value);
  if (!maxChars || maxChars < 0 || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
};

const mergeSmsBinding = async (sessionStore, sessionId, patch) => {
  const current = (await sessionStore.getSession(sessionId)) || { id: sessionId };
  const currentBindings = current.channelBindings || {};
  const currentSms = currentBindings.sms || {};

  await sessionStore.upsertSession(sessionId, {
    channelBindings: {
      ...currentBindings,
      sms: {
        ...currentSms,
        ...patch
      }
    }
  });
};

const buildSmsSystemPrompt = ({ defaultPrompt, event, maxReplyChars }) =>
  [
    trimToString(defaultPrompt),
    "",
    "SMS metadata:",
    `- Provider: ${event.provider}`,
    `- From: ${event.from}`,
    `- To: ${event.to}`,
    `- Account ID: ${event.accountId || "unknown"}`,
    `- Reply with plain text only and keep the message under ${maxReplyChars} characters.`
  ]
    .filter(Boolean)
    .join("\n");

export const createSmsChannelService = ({ agentService, sessionStore, config }) => {
  const smsConfig = config.channels?.sms || {};

  const providerName = trimToString(smsConfig.provider || "twilio").toLowerCase();
  const providers = new Map([
    ["twilio", createTwilioSmsAdapter(smsConfig.twilio || {})]
  ]);

  const provider = providers.get(providerName);

  const findSessionForConversation = async (conversationKey) => {
    const sessions = await sessionStore.listSessions();
    return sessions.find((session) => session?.channelBindings?.sms?.conversationKey === conversationKey);
  };

  const ensureSession = async ({ conversationKey, event }) => {
    const existing = await findSessionForConversation(conversationKey);
    if (existing?.id) {
      return { id: existing.id, created: false };
    }

    const created = await agentService.createSession({
      title: `SMS ${event.from} -> ${event.to}`,
      channel: `sms:${providerName}`
    });
    return { id: created.id, created: true };
  };

  const buildReplyPayload = (text) => ({
    contentType: "text/xml; charset=utf-8",
    body: provider.formatReply(text)
  });

  const fallbackReply = truncateText(
    smsConfig.fallbackReply || "I hit an error processing that. Please try again shortly.",
    smsConfig.maxReplyChars
  );

  const handleInboundWebhook = async ({ headers, form, path, queryString }) => {
    if (!smsConfig.enabled) {
      return {
        ok: false,
        status: 404,
        error: "SMS channel is disabled."
      };
    }

    if (!provider) {
      return {
        ok: false,
        status: 500,
        error: `Unsupported SMS provider: ${providerName}`
      };
    }

    const parsed = provider.parseInbound(form);
    if (!parsed.ok) return parsed;

    const event = parsed.event;
    if (!provider.isAllowedDestination(event.to)) {
      return {
        ok: false,
        status: 403,
        error: "Inbound SMS destination number is not allowed."
      };
    }

    const signatureUrl = createTwilioSignatureUrl({
      webhookBaseUrl: smsConfig.twilio?.webhookBaseUrl,
      path,
      queryString,
      headers
    });
    const verification = provider.verifyRequest({
      headers,
      form,
      signatureUrl
    });
    if (!verification.ok) return verification;

    const conversationKey = createSmsConversationKey({
      provider: provider.provider,
      accountId: event.accountId || "default",
      to: event.to,
      from: event.from
    });

    try {
      const session = await ensureSession({ conversationKey, event });
      const systemPrompt = buildSmsSystemPrompt({
        defaultPrompt: smsConfig.defaultSystemPrompt,
        event,
        maxReplyChars: smsConfig.maxReplyChars
      });
      const reply = await agentService.sendUserMessage({
        sessionId: session.id,
        text: event.text,
        system: systemPrompt
      });

      const assistantText = truncateText(reply.assistantText || fallbackReply, smsConfig.maxReplyChars);
      const now = new Date().toISOString();
      await mergeSmsBinding(sessionStore, session.id, {
        provider: provider.provider,
        conversationKey,
        accountId: event.accountId || "",
        from: event.from,
        to: event.to,
        lastInboundMessageId: event.messageId || "",
        lastInboundAt: now,
        lastInboundText: truncateText(event.text, 500),
        lastReplyAt: now,
        lastReplyText: assistantText
      });

      return {
        ok: true,
        status: 200,
        sessionId: session.id,
        conversationKey,
        createdSession: session.created,
        response: buildReplyPayload(assistantText)
      };
    } catch {
      return {
        ok: true,
        status: 200,
        sessionId: null,
        conversationKey,
        createdSession: false,
        response: buildReplyPayload(fallbackReply)
      };
    }
  };

  return {
    isEnabled: () => Boolean(smsConfig.enabled),
    inboundPath: () => smsConfig.inboundPath || "/channels/sms/inbound",
    handleInboundWebhook
  };
};
