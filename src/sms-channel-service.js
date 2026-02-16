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

const MIN_CHARS_FOR_SEQUENCE_BODY = 8;
const MAX_SEQUENCE_RETRY_PASSES = 4;

const withSmsSequenceLabels = (value, maxChars) => {
  const text = trimToString(value);
  if (!text) return [];

  let segments = splitTextForSmsMessages(text, maxChars);
  if (segments.length <= 1 || !maxChars || maxChars < 1) return segments;

  for (let pass = 0; pass < MAX_SEQUENCE_RETRY_PASSES; pass += 1) {
    const total = segments.length;
    const width = String(total).length;
    const formatCount = (count) => String(count).padStart(width, "0");
    const prefix = `[${formatCount(total)}/${formatCount(total)}] `;
    const bodyMaxChars = maxChars - prefix.length;
    if (bodyMaxChars < MIN_CHARS_FOR_SEQUENCE_BODY) return segments;

    const next = splitTextForSmsMessages(text, bodyMaxChars);
    if (next.length === total) {
      return next.map(
        (segment, index) => `[${formatCount(index + 1)}/${formatCount(total)}] ${segment}`
      );
    }
    segments = next;
  }

  const total = segments.length;
  const width = String(total).length;
  const formatCount = (count) => String(count).padStart(width, "0");
  return segments.map((segment, index) => {
    const prefix = `[${formatCount(index + 1)}/${formatCount(total)}] `;
    const bodyMaxChars = Math.max(1, maxChars - prefix.length);
    return `${prefix}${truncateText(segment, bodyMaxChars)}`;
  });
};

const formatSmsReplyMessages = (value, { maxChars, includeSequenceLabels }) => {
  const normalized = normalizeSmsText(value);
  if (!normalized) return [];

  if (!includeSequenceLabels) {
    return splitTextForSmsMessages(normalized, maxChars);
  }

  return withSmsSequenceLabels(normalized, maxChars);
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
    "- If a site returns JS-required, 403, or empty content, call the fetch_webpage tool before reporting access limitations.",
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
  const conversationQueueTailByKey = new Map();

  const enqueueConversationWork = async (conversationKey, run) => {
    const prior = conversationQueueTailByKey.get(conversationKey) || Promise.resolve();
    const started = prior
      .catch(() => {})
      .then(run);
    const tail = started.finally(() => {
      if (conversationQueueTailByKey.get(conversationKey) === tail) {
        conversationQueueTailByKey.delete(conversationKey);
      }
    });
    conversationQueueTailByKey.set(conversationKey, tail);
    return started;
  };

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

  const toReplyMessages = (text) =>
    formatSmsReplyMessages(text, {
      maxChars: smsConfig.maxReplyChars,
      includeSequenceLabels: Boolean(smsConfig.includeSequenceLabels)
    });

  const fallbackReplyMessages = toReplyMessages(
    smsConfig.fallbackReply || "I hit an error processing that. Please try again shortly."
  );
  const unauthorizedReplyMessages = toReplyMessages(
    smsConfig.unauthorizedReply || "This phone number is not authorized to use this SMS channel."
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

    return enqueueConversationWork(conversationKey, async () => {
      try {
        const command = parseSharedChatCommand(event.text);
        if (command.isCommand) {
          if (command.name === "help") {
            const replyMessages = toReplyMessages(sharedChatCommandHelpText());
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
            const replyMessages = toReplyMessages(sessionText);
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
            const replyMessages = toReplyMessages(replyText);
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
        const assistantReplyMessages = toReplyMessages(
          reply.assistantText || fallbackReplyMessages.join("\n")
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
    });
  };

  return {
    isEnabled: () => Boolean(smsConfig.enabled),
    inboundPath: () => smsConfig.inboundPath || "/channels/sms/inbound",
    handleInboundWebhook
  };
};
