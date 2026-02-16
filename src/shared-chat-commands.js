const HELP_COMMAND = "/help";
const SESSION_COMMAND = "/session";
const SESSION_NEW_COMMAND = "/session-new";

const hasCommandBoundary = (value, command) => {
  const boundary = value.charAt(command.length);
  return !boundary || /\s/.test(boundary);
};

export const parseSharedChatCommand = (value) => {
  if (typeof value !== "string") return { isCommand: false };
  const trimmed = value.trim();
  if (!trimmed) return { isCommand: false };

  if (trimmed === HELP_COMMAND) {
    return { isCommand: true, name: "help" };
  }

  if (trimmed === SESSION_COMMAND) {
    return { isCommand: true, name: "session" };
  }

  if (
    trimmed.startsWith(SESSION_NEW_COMMAND) &&
    hasCommandBoundary(trimmed, SESSION_NEW_COMMAND)
  ) {
    return {
      isCommand: true,
      name: "session-new",
      title: trimmed.slice(SESSION_NEW_COMMAND.length).trim()
    };
  }

  return { isCommand: false };
};

export const sharedChatCommandHelpLines = () => [
  "/help  show chat commands",
  "/session  show current session id",
  "/session-new [title]  start a new session"
];

export const sharedChatCommandHelpText = () => sharedChatCommandHelpLines().join("\n");
