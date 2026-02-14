const REMEMBER_COMMAND = "/remember";

const isWhitespace = (value) => /\s/.test(value);

export const parseRememberCommand = (value) => {
  if (typeof value !== "string") {
    return { isRememberCommand: false, text: "" };
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith(REMEMBER_COMMAND)) {
    return { isRememberCommand: false, text: "" };
  }

  const boundaryCharacter = trimmed.charAt(REMEMBER_COMMAND.length);
  if (boundaryCharacter && !isWhitespace(boundaryCharacter)) {
    return { isRememberCommand: false, text: "" };
  }

  return {
    isRememberCommand: true,
    text: trimmed.slice(REMEMBER_COMMAND.length).trim()
  };
};
