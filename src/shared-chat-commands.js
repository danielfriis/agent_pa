const HELP_COMMAND = "/help";
const SESSION_COMMAND = "/session";
const SESSION_NEW_COMMAND = "/session-new";
const UPDATE_COMMAND = "/update";
const UPDATE_STATUS_COMMAND = "/update-status";

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

  if (
    trimmed.startsWith(UPDATE_COMMAND) &&
    hasCommandBoundary(trimmed, UPDATE_COMMAND)
  ) {
    return {
      isCommand: true,
      name: "update",
      argsText: trimmed.slice(UPDATE_COMMAND.length).trim()
    };
  }

  if (trimmed === UPDATE_STATUS_COMMAND) {
    return { isCommand: true, name: "update-status" };
  }

  return { isCommand: false };
};

export const sharedChatCommandHelpLines = () => [
  "/help  show chat commands",
  "/session  show current session id",
  "/session-new [title]  start a new session",
  "/update [--branch NAME] [--remote NAME] [--skip-deps] [--skip-check]  start update script",
  "/update-status  show current/last update status"
];

export const sharedChatCommandHelpText = () => sharedChatCommandHelpLines().join("\n");
