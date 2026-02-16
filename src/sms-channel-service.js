import {
  createSmsConversationKey,
  createTwilioSignatureUrl,
  createTwilioSmsAdapter
} from "./sms-provider-twilio.js";
import {
  parseSharedChatCommand,
  sharedChatCommandHelpText
} from "./shared-chat-commands.js";

const trimToString = (value) => String(value || "").trim();

const truncateText = (value, maxChars) => {
  const text = trimToString(value);
  if (!maxChars || maxChars < 0 || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
};

const normalizeSmsText = (value) => {
  let text = trimToString(value);
  if (!text) return "";

  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1$2")
    .replace(/[•▪▫◦]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/→/g, "->")
    .replace(/\u00a0/g, " ");

  text = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(#{1,6})\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s*[–—]\s+/, "- ")
    )
    .join("\n");

  text = text
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
};

const splitTextForSmsMessages = (value, maxChars) => {
  const text = trimToString(value);
  if (!text) return [];
  if (!maxChars || maxChars < 1 || text.length <= maxChars) return [text];

  const messages = [];
  const pushMessage = (next) => {
    const cleaned = trimToString(next);
    if (!cleaned) return;
    messages.push(cleaned);
  };

  const splitParagraph = (paragraph) => {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      if (word.length > maxChars) {
        if (current) {
          pushMessage(current);
          current = "";
        }
        for (let start = 0; start < word.length; start += maxChars) {
          pushMessage(word.slice(start, start + maxChars));
        }
        continue;
      }

      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      pushMessage(current);
      current = word;
    }

    if (current) pushMessage(current);
  };

  const paragraphs = text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      splitParagraph(paragraph);
      continue;
    }

    const last = messages[messages.length - 1];
    if (last && `${last}\n${paragraph}`.length <= maxChars) {
      messages[messages.length - 1] = `${last}\n${paragraph}`;
      continue;
    }
    pushMessage(paragraph);
  }

  return messages.length ? messages : [text.slice(0, maxChars)];
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

const unbindConversationKeyFromOtherSessions = async (
  sessionStore,
  conversationKey,
  keepSessionId
) => {
  const sessions = await sessionStore.listSessions();
  const matches = sessions.filter(
    (session) =>
      session?.id &&
      session.id !== keepSessionId &&
      session?.channelBindings?.sms?.conversationKey === conversationKey
  );
  for (const session of matches) {
    await mergeSmsBinding(sessionStore, session.id, {
      conversationKey: ""
    });
  }
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
    "- You still have access to all tools and skills available in this runtime. SMS only changes response formatting.",
    `- Reply with plain text only. If needed, split across multiple SMS messages and keep each message under ${maxReplyChars} characters.`
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

  const buildReplyPayload = (messages) => ({
    contentType: "text/xml; charset=utf-8",
    body: provider.formatReply(messages)
  });

  const fallbackReplyMessages = splitTextForSmsMessages(
    normalizeSmsText(smsConfig.fallbackReply || "I hit an error processing that. Please try again shortly."),
    smsConfig.maxReplyChars
  );
  const unauthorizedReplyMessages = splitTextForSmsMessages(
    normalizeSmsText(
      smsConfig.unauthorizedReply || "This phone number is not authorized to use this SMS channel."
    ),
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
    if (typeof provider.isAllowedSender === "function" && !provider.isAllowedSender(event.from)) {
      return {
        ok: true,
        status: 200,
        sessionId: null,
        conversationKey: null,
        createdSession: false,
        response: buildReplyPayload(unauthorizedReplyMessages)
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
      const command = parseSharedChatCommand(event.text);
      if (command.isCommand) {
        if (command.name === "help") {
          const replyMessages = splitTextForSmsMessages(
            normalizeSmsText(sharedChatCommandHelpText()),
            smsConfig.maxReplyChars
          );
          return {
            ok: true,
            status: 200,
            sessionId: null,
            conversationKey,
            createdSession: false,
            response: buildReplyPayload(replyMessages)
          };
        }

        if (command.name === "session") {
          const existing = await findSessionForConversation(conversationKey);
          const sessionText = existing?.id
            ? `Current session: ${existing.id}`
            : "No active session. Use /session-new [title] to start one.";
          const replyMessages = splitTextForSmsMessages(
            normalizeSmsText(sessionText),
            smsConfig.maxReplyChars
          );
          return {
            ok: true,
            status: 200,
            sessionId: existing?.id || null,
            conversationKey,
            createdSession: false,
            response: buildReplyPayload(replyMessages)
          };
        }

        if (command.name === "session-new") {
          const created = await agentService.createSession({
            title: command.title || `SMS ${event.from} -> ${event.to}`,
            channel: `sms:${providerName}`
          });
          await unbindConversationKeyFromOtherSessions(
            sessionStore,
            conversationKey,
            created.id
          );
          const replyText = `Started new session: ${created.id}`;
          const now = new Date().toISOString();
          await mergeSmsBinding(sessionStore, created.id, {
            provider: provider.provider,
            conversationKey,
            accountId: event.accountId || "",
            from: event.from,
            to: event.to,
            lastInboundMessageId: event.messageId || "",
            lastInboundAt: now,
            lastInboundText: truncateText(event.text, 500),
            lastReplyAt: now,
            lastReplyText: truncateText(replyText, 5000)
          });
          const replyMessages = splitTextForSmsMessages(
            normalizeSmsText(replyText),
            smsConfig.maxReplyChars
          );
          return {
            ok: true,
            status: 200,
            sessionId: created.id,
            conversationKey,
            createdSession: true,
            response: buildReplyPayload(replyMessages)
          };
        }
      }

      const session = await ensureSession({ conversationKey, event });
      const systemPrompt = buildSmsSystemPrompt({
        defaultPrompt: smsConfig.defaultSystemPrompt,
        event,
        maxReplyChars: smsConfig.maxReplyChars
      });
      const reply = await agentService.sendUserMessage({
        sessionId: session.id,
        text: event.text,
        system: systemPrompt,
        channel: `sms:${providerName}`
      });
      const assistantReplyText = normalizeSmsText(
        reply.assistantText || fallbackReplyMessages.join("\n")
      );

      const assistantReplyMessages = splitTextForSmsMessages(
        assistantReplyText || fallbackReplyMessages.join("\n"),
        smsConfig.maxReplyChars
      );
      const assistantText = truncateText(assistantReplyMessages.join("\n"), 5000);
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
        response: buildReplyPayload(assistantReplyMessages)
      };
    } catch (error) {
      const detail = error instanceof Error ? error.stack || error.message : String(error);
      process.stderr.write(`[agent-pa] sms inbound failed: ${detail}\n`);
      return {
        ok: true,
        status: 200,
        sessionId: null,
        conversationKey,
        createdSession: false,
        response: buildReplyPayload(fallbackReplyMessages)
      };
    }
  };

  return {
    isEnabled: () => Boolean(smsConfig.enabled),
    inboundPath: () => smsConfig.inboundPath || "/channels/sms/inbound",
    handleInboundWebhook
  };
};
