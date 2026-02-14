const TOOL_EXECUTION_POLICY = `Tool execution policy:
- Tool calls are the only valid mechanism for side effects.
- Every tool call must resolve to a structured result with either \`ok: true\` or \`ok: false\`.
- Treat \`ok: false\` as a failure and surface the tool's \`error\` message to the user.
- Never claim a tool-backed action succeeded unless the tool result includes \`ok: true\`.
- For memory persistence requests, use the \`add_memory\` tool.`;

export const createMemorySystemInjector = (workspace) => async (payload, customSystem) => {
  const [memory, persistentSystemPrompt] = await Promise.all([
    workspace.readMemoryForPrompt(),
    workspace.readSystemPrompt()
  ]);
  if (!memory.trim() && !persistentSystemPrompt.trim() && !customSystem && !payload.system) {
    return payload;
  }

  const memoryBlock = memory.trim()
    ? `Persistent memory (from config file):\n${memory}`
    : "";
  const joined = [
    persistentSystemPrompt.trim() || "",
    TOOL_EXECUTION_POLICY,
    payload.system,
    customSystem,
    memoryBlock
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    ...payload,
    system: joined
  };
};
