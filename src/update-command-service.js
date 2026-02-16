import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_CHARS = 12000;
const DEFAULT_PERSIST_FILENAME = "update-status.json";
const STARTED_CODE = "started";
const ALREADY_RUNNING_CODE = "already_running";
const DISABLED_CODE = "disabled";
const INVALID_ARGS_CODE = "invalid_args";
const SCRIPT_UNAVAILABLE_CODE = "script_unavailable";
const INTERRUPTED_CODE = "interrupted";

const trimToString = (value) => String(value || "").trim();

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const appendTail = (current, chunk, maxChars) => {
  const next = `${current}${chunk}`;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
};

const truncateText = (value, maxChars) => {
  const text = trimToString(value);
  if (!text || maxChars < 1 || text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
};

const formatDurationMs = (value) => {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 1) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
};

const formatArgs = (args) => (args?.length ? args.join(" ") : "(none)");

const sanitizeRun = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    id: trimToString(value.id) || null,
    status: trimToString(value.status) || "failed",
    code: trimToString(value.code) || "unknown",
    scriptPath: trimToString(value.scriptPath),
    args: Array.isArray(value.args) ? value.args.map((item) => String(item)) : [],
    channel: trimToString(value.channel),
    requestedBy: trimToString(value.requestedBy),
    startedAt: trimToString(value.startedAt),
    completedAt: trimToString(value.completedAt) || null,
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : 0,
    exitCode:
      value.exitCode === null || value.exitCode === undefined
        ? null
        : Number.isFinite(Number(value.exitCode))
          ? Number(value.exitCode)
          : null,
    signal: trimToString(value.signal) || null,
    timedOut: Boolean(value.timedOut),
    pid:
      value.pid === null || value.pid === undefined
        ? null
        : Number.isFinite(Number(value.pid))
          ? Number(value.pid)
          : null,
    error: trimToString(value.error),
    stdout: trimToString(value.stdout),
    stderr: trimToString(value.stderr)
  };
};

const parseUpdateArgsText = (value) => {
  const tokens = trimToString(value)
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return { ok: true, args: [] };

  const args = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--skip-deps" || token === "--skip-check" || token === "--help") {
      args.push(token);
      continue;
    }

    if (token === "--branch" || token === "--remote") {
      const valueToken = tokens[index + 1];
      if (!valueToken) {
        return {
          ok: false,
          error: `Missing value for ${token}.`
        };
      }
      args.push(token, valueToken);
      index += 1;
      continue;
    }

    return {
      ok: false,
      error:
        `Unsupported update option: ${token}. ` +
        "Allowed: --branch <name>, --remote <name>, --skip-deps, --skip-check, --help"
    };
  }

  return { ok: true, args };
};

const createRunSnapshot = (run) => {
  if (!run) return null;

  const now = Date.now();
  const durationMs = run.completedAtMs
    ? run.completedAtMs - run.startedAtMs
    : now - run.startedAtMs;

  return {
    id: run.id,
    status: run.status,
    code: run.code,
    scriptPath: run.scriptPath,
    args: [...run.args],
    channel: run.channel,
    requestedBy: run.requestedBy,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    pid: run.pid,
    error: run.error,
    stdout: run.stdout,
    stderr: run.stderr
  };
};

export const formatUpdateStartText = (result) => {
  if (!result?.ok) {
    if (result?.code === ALREADY_RUNNING_CODE && result.run) {
      return [
        `Update already running: ${result.run.id}`,
        `Started: ${result.run.startedAt}`,
        `Args: ${formatArgs(result.run.args)}`,
        "Use /update-status for progress."
      ].join("\n");
    }
    return `Update could not start: ${result?.error || "Unknown error."}`;
  }

  return [
    `Update started: ${result.run.id}`,
    `Args: ${formatArgs(result.run.args)}`,
    "Use /update-status for progress."
  ].join("\n");
};

export const formatUpdateStatusText = (status) => {
  if (!status?.ok) {
    return `Could not read update status: ${status?.error || "Unknown error."}`;
  }

  if (status.running && status.currentRun) {
    const lines = [
      `Update in progress: ${status.currentRun.id}`,
      `Started: ${status.currentRun.startedAt}`,
      `Args: ${formatArgs(status.currentRun.args)}`,
      `Elapsed: ${formatDurationMs(status.currentRun.durationMs)}`
    ];

    const recentOutput = truncateText(
      [status.currentRun.stdout, status.currentRun.stderr].filter(Boolean).join("\n"),
      1200
    );
    if (recentOutput) {
      lines.push("Recent output:");
      lines.push(recentOutput);
    }

    return lines.join("\n");
  }

  if (!status.lastRun) {
    return "No update has run yet.";
  }

  const run = status.lastRun;
  const lines = [
    `Last update: ${run.status}`,
    `Run: ${run.id}`,
    `Started: ${run.startedAt}`,
    `Finished: ${run.completedAt || "unknown"}`,
    `Duration: ${formatDurationMs(run.durationMs)}`,
    `Args: ${formatArgs(run.args)}`
  ];

  if (run.exitCode !== null && run.exitCode !== undefined) {
    lines.push(`Exit code: ${run.exitCode}`);
  }
  if (run.signal) {
    lines.push(`Signal: ${run.signal}`);
  }
  if (run.timedOut) {
    lines.push("Timed out: yes");
  }
  if (run.error) {
    lines.push(`Error: ${run.error}`);
  }

  const recentOutput = truncateText([run.stdout, run.stderr].filter(Boolean).join("\n"), 1200);
  if (recentOutput) {
    lines.push("Recent output:");
    lines.push(recentOutput);
  }

  return lines.join("\n");
};

export const createUpdateCommandService = ({
  enabled = true,
  scriptPath = path.resolve(process.cwd(), "deploy/update-server.sh"),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
  statusFilePath = path.resolve(process.cwd(), "agent_config", "maintenance", DEFAULT_PERSIST_FILENAME)
} = {}) => {
  const resolvedScriptPath = path.resolve(scriptPath);
  const resolvedTimeoutMs = toPositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS);
  const resolvedMaxOutputChars = toPositiveInt(maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
  const resolvedStatusFilePath = statusFilePath ? path.resolve(statusFilePath) : "";

  let runCounter = 0;
  let currentRun = null;
  let lastRun = null;
  let persistenceError = "";
  let persistenceTail = Promise.resolve();

  const persistState = async () => {
    if (!resolvedStatusFilePath) return;

    const state = {
      updatedAt: new Date().toISOString(),
      currentRun: createRunSnapshot(currentRun),
      lastRun
    };

    await fs.mkdir(path.dirname(resolvedStatusFilePath), { recursive: true });
    await fs.writeFile(resolvedStatusFilePath, JSON.stringify(state, null, 2), "utf8");
    persistenceError = "";
  };

  const queuePersistState = () => {
    persistenceTail = persistenceTail
      .catch(() => {})
      .then(() => persistState())
      .catch((error) => {
        persistenceError = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[agent-pa] warning: failed to persist update status at ${resolvedStatusFilePath}: ${persistenceError}\n`
        );
      });
    return persistenceTail;
  };

  const loadPersistedState = async () => {
    if (!resolvedStatusFilePath) return;
    try {
      const raw = await fs.readFile(resolvedStatusFilePath, "utf8");
      const parsed = JSON.parse(raw);
      const persistedLastRun = sanitizeRun(parsed?.lastRun);
      const persistedCurrentRun = sanitizeRun(parsed?.currentRun);
      if (persistedLastRun) {
        lastRun = persistedLastRun;
      }
      if (persistedCurrentRun) {
        // If the service restarted while a run was marked running, record it as interrupted.
        const interruptedAt = new Date().toISOString();
        lastRun = {
          ...persistedCurrentRun,
          status: "failed",
          code: INTERRUPTED_CODE,
          completedAt: interruptedAt,
          error:
            persistedCurrentRun.error ||
            "Update status was interrupted by a service restart before completion."
        };
        currentRun = null;
        await persistState();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Missing status file is expected on first run.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error).code === "ENOENT"
      ) {
        return;
      }
      persistenceError = detail;
      process.stderr.write(
        `[agent-pa] warning: failed to load update status from ${resolvedStatusFilePath}: ${detail}\n`
      );
    }
  };

  const initPromise = loadPersistedState();

  const getStatus = async () => {
    await initPromise;
    return {
      ok: true,
      running: Boolean(currentRun),
      currentRun: createRunSnapshot(currentRun),
      lastRun,
      persistenceError: persistenceError || null
    };
  };

  const startUpdate = async ({ argsText = "", channel = "unknown", requestedBy = "" } = {}) => {
    await initPromise;

    if (!enabled) {
      return {
        ok: false,
        code: DISABLED_CODE,
        error: "Update command is disabled."
      };
    }

    const parsedArgs = parseUpdateArgsText(argsText);
    if (!parsedArgs.ok) {
      return {
        ok: false,
        code: INVALID_ARGS_CODE,
        error: parsedArgs.error
      };
    }

    if (currentRun) {
      return {
        ok: false,
        code: ALREADY_RUNNING_CODE,
        error: `Update run ${currentRun.id} is already in progress.`,
        run: createRunSnapshot(currentRun)
      };
    }

    try {
      await fs.access(resolvedScriptPath, fsConstants.X_OK);
    } catch (error) {
      return {
        ok: false,
        code: SCRIPT_UNAVAILABLE_CODE,
        error:
          `Update script is not executable at ${resolvedScriptPath}. ` +
          `(${error instanceof Error ? error.message : String(error)})`
      };
    }

    const nowMs = Date.now();
    const startedAt = new Date(nowMs).toISOString();
    const run = {
      id: `upd_${nowMs}_${(runCounter += 1)}`,
      status: "running",
      code: STARTED_CODE,
      scriptPath: resolvedScriptPath,
      args: parsedArgs.args,
      channel,
      requestedBy: trimToString(requestedBy),
      startedAt,
      startedAtMs: nowMs,
      completedAt: null,
      completedAtMs: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      pid: null,
      error: "",
      stdout: "",
      stderr: ""
    };

    currentRun = run;
    await queuePersistState();

    let settled = false;
    let timeoutTimer = null;
    let forcedKillTimer = null;
    let child = null;

    const completeRun = ({ status, code, exitCode = null, signal = null, error = "" }) => {
      if (settled) return;
      settled = true;

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);

      const completedAtMs = Date.now();
      run.completedAtMs = completedAtMs;
      run.completedAt = new Date(completedAtMs).toISOString();
      run.status = status;
      run.code = code;
      run.exitCode = exitCode;
      run.signal = signal;
      run.error = trimToString(error);

      lastRun = createRunSnapshot(run);
      currentRun = null;
      void queuePersistState();
    };

    try {
      child = spawn(resolvedScriptPath, parsedArgs.args, {
        cwd: path.dirname(resolvedScriptPath),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      completeRun({
        status: "failed",
        code: "spawn_error",
        error: `Failed to start update script: ${detail}`
      });
      return {
        ok: false,
        code: "spawn_error",
        error: `Failed to start update script: ${detail}`
      };
    }

    run.pid = child.pid || null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      run.stdout = appendTail(run.stdout, String(chunk), resolvedMaxOutputChars);
    });

    child.stderr?.on("data", (chunk) => {
      run.stderr = appendTail(run.stderr, String(chunk), resolvedMaxOutputChars);
    });

    child.once("error", (error) => {
      const detail = error instanceof Error ? error.message : String(error);
      completeRun({
        status: "failed",
        code: "spawn_error",
        error: `Failed to execute update script: ${detail}`
      });
    });

    child.once("close", (exitCode, signal) => {
      if (run.timedOut) {
        completeRun({
          status: "failed",
          code: "timed_out",
          exitCode,
          signal,
          error: `Update timed out after ${resolvedTimeoutMs}ms.`
        });
        return;
      }

      if (exitCode === 0) {
        completeRun({
          status: "succeeded",
          code: "succeeded",
          exitCode,
          signal
        });
        return;
      }

      completeRun({
        status: "failed",
        code: "failed",
        exitCode,
        signal,
        error: `Update script exited with code ${exitCode ?? "unknown"}.`
      });
    });

    timeoutTimer = setTimeout(() => {
      if (settled || !child) return;
      run.timedOut = true;
      child.kill("SIGTERM");
      forcedKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 3000);
    }, resolvedTimeoutMs);

    return {
      ok: true,
      code: STARTED_CODE,
      run: createRunSnapshot(run)
    };
  };

  return {
    isEnabled: () => Boolean(enabled),
    scriptPath: () => resolvedScriptPath,
    startUpdate,
    getStatus
  };
};
