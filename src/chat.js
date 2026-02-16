import readline from "node:readline";

import { parseRememberCommand } from "./remember-command.js";
import {
  parseSharedChatCommand,
  sharedChatCommandHelpLines
} from "./shared-chat-commands.js";

const parseChatModel = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  const [providerID, modelID] = raw.split("/");
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
};

export const startTerminalChat = async ({
  agentService,
  workspace,
  shutdown,
  syncSkills
}) => {
  const ready = await agentService.waitForOpenCode();
  if (!ready) {
    process.stdout.write("[chat] OpenCode is unavailable, skipping terminal chat mode.\n");
    return;
  }

  let model = parseChatModel(process.env.CHAT_MODEL);
  let session = await agentService.createSession({
    title: `${process.env.CHAT_SESSION_TITLE_PREFIX || "Terminal chat"} ${new Date().toISOString()}`,
    channel: "terminal"
  });

  process.stdout.write(`[chat] Session: ${session.id}\n`);
  process.stdout.write("[chat] Type /help for commands.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let busy = false;
  let closed = false;
  const prompt = () => {
    if (closed) return;
    rl.setPrompt("you> ");
    rl.prompt();
  };
  prompt();

  rl.on("line", (line) => {
    const input = line.trim();
    if (!input) {
      prompt();
      return;
    }

    if (input === "/exit") {
      rl.close();
      void shutdown();
      return;
    }

    if (busy) {
      process.stdout.write("[chat] Busy. Wait for current response.\n");
      prompt();
      return;
    }

    const sharedCommand = parseSharedChatCommand(input);
    if (sharedCommand.isCommand) {
      if (sharedCommand.name === "help") {
        process.stdout.write(
          `${[
            ...sharedChatCommandHelpLines(),
            "/model PROVIDER/MODEL  set per-chat model override",
            "/workspace  show workspace paths",
            "/memory  show current memory file",
            "/remember TEXT  append to persistent memory",
            "/skills  list local skills",
            "/skill-new NAME  create a skill markdown file",
            "/exit  stop chat and server"
          ].join("\n")}\n`
        );
        prompt();
        return;
      }

      if (sharedCommand.name === "session") {
        process.stdout.write(`[chat] ${session.id}\n`);
        prompt();
        return;
      }

      if (sharedCommand.name === "session-new") {
        const title = sharedCommand.title || `Terminal chat ${new Date().toISOString()}`;
        busy = true;
        void (async () => {
          try {
            session = await agentService.createSession({ title, channel: "terminal" });
            process.stdout.write(`[chat] New session: ${session.id}\n`);
          } catch (error) {
            process.stdout.write(
              `[chat] Failed to create session: ${
                error instanceof Error ? error.message : String(error)
              }\n`
            );
          } finally {
            busy = false;
            prompt();
          }
        })();
        return;
      }
    }

    if (input === "/workspace") {
      process.stdout.write(`${JSON.stringify(workspace.summary(), null, 2)}\n`);
      prompt();
      return;
    }

    if (input === "/memory") {
      busy = true;
      void (async () => {
        try {
          const memory = await workspace.readMemory();
          process.stdout.write(`${memory || "[empty]"}\n`);
        } finally {
          busy = false;
          prompt();
        }
      })();
      return;
    }

    const rememberFromUser = parseRememberCommand(input);
    if (rememberFromUser.isRememberCommand) {
      if (!rememberFromUser.text) {
        process.stdout.write("[chat] Missing text. Usage: /remember <text>\n");
        prompt();
        return;
      }
      busy = true;
      void (async () => {
        try {
          await workspace.appendMemory(rememberFromUser.text);
          process.stdout.write("[chat] Saved to memory.\n");
        } catch (error) {
          process.stdout.write(`[chat] Failed to save memory: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          busy = false;
          prompt();
        }
      })();
      return;
    }

    if (input === "/skills") {
      busy = true;
      void (async () => {
        try {
          const skills = await workspace.listSkills();
          process.stdout.write(skills.length ? `${skills.join("\n")}\n` : "[chat] No local skills yet.\n");
        } catch (error) {
          process.stdout.write(`[chat] Failed to list skills: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          busy = false;
          prompt();
        }
      })();
      return;
    }

    if (input.startsWith("/skill-new ")) {
      const name = input.replace("/skill-new ", "").trim();
      if (!name) {
        process.stdout.write("[chat] Missing name. Usage: /skill-new <name>\n");
        prompt();
        return;
      }
      busy = true;
      void (async () => {
        try {
          const filePath = await workspace.createSkill(name);
          const syncResult = await syncSkills();
          process.stdout.write(`[chat] Created skill file: ${filePath}\n`);
          process.stdout.write(
            `[chat] Synced ${syncResult.syncedCount} skill(s) to ${syncResult.targetDir}\n`
          );
        } catch (error) {
          process.stdout.write(`[chat] Failed to create skill: ${error instanceof Error ? error.message : String(error)}\n`);
        } finally {
          busy = false;
          prompt();
        }
      })();
      return;
    }

    if (input.startsWith("/model")) {
      const raw = input.replace("/model", "").trim();
      const parsed = parseChatModel(raw);
      if (!parsed) {
        process.stdout.write("[chat] Invalid format. Use: /model providerID/modelID\n");
      } else {
        model = parsed;
        process.stdout.write(`[chat] Model set to ${model.providerID}/${model.modelID}\n`);
      }
      prompt();
      return;
    }

    busy = true;
    void (async () => {
      try {
        const reply = await agentService.sendUserMessage({
          sessionId: session.id,
          text: input,
          model,
          channel: "terminal"
        });
        const assistantText = reply.assistantText;
        const assistantPartTypes = reply.assistantPartTypes;

        process.stdout.write(
          `assistant> ${assistantText || "[response received with no text output]"}\n`
        );
        if (!assistantText && assistantPartTypes.length) {
          process.stdout.write(
            `[chat] Assistant emitted non-text parts: ${assistantPartTypes.join(", ")}\n`
          );
        }
        if (!assistantText && !assistantPartTypes.length) {
          process.stdout.write(
            `[chat] No assistant output found. Recent messages: ${reply.diagnostics?.recentMessages || "none"}\n`
          );
          process.stdout.write(
            `[chat] Latest assistant info: ${reply.diagnostics?.latestAssistantInfo || "none"}\n`
          );
          const raw = reply.diagnostics?.latestAssistantRaw;
          if (raw) {
            process.stdout.write(`[chat] Latest assistant raw: ${JSON.stringify(raw)}\n`);
          }
        }
      } catch (error) {
        process.stdout.write(
          `[chat] Request failed: ${error instanceof Error ? error.message : String(error)}\n`
        );
      } finally {
        busy = false;
        prompt();
      }
    })();
  });

  rl.on("close", () => {
    closed = true;
    process.stdout.write("[chat] Closed.\n");
  });
};
