// bridge/main.ts
import { stat } from "node:fs/promises";
import * as path2 from "node:path";

// src/shared/ssh/SSHConnection.ts
var DEFAULT_SSH_CONNECTION = {
  enabled: false,
  host: "",
  port: 22,
  identityFile: "",
  remoteDirectory: "",
  cliPath: "claude",
  executable: "ssh"
};
var SSHConnectionError = class extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
    this.name = "SSHConnectionError";
  }
};
function quoteSSHArgument(value) {
  if (value.includes("\0")) throw new SSHConnectionError("SSH arguments cannot contain NUL");
  return `'${value.replace(/'/gu, "'\\''")}'`;
}
function buildSSHCommand(connection, invocation) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/u.test(connection.host)) throw new SSHConnectionError("Set a valid SSH host or user@host");
  if (!connection.remoteDirectory.startsWith("/")) throw new SSHConnectionError("Set an absolute remote workspace path");
  if (!connection.executable.trim() || !connection.cliPath.trim()) throw new SSHConnectionError("Set the SSH and remote Claude executables");
  const environment = Object.entries(invocation.environment).map(([key, value]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key)) throw new SSHConnectionError(`Invalid environment name: ${key}`);
    return value === void 0 ? [] : [`${key}=${value}`];
  }).flat();
  const script = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"; cd "$1" || exit; shift; exec env "$@"';
  const remote = ["/bin/sh", "-c", script, "kk-nerodian", connection.remoteDirectory, ...environment, invocation.command, ...invocation.args].map(quoteSSHArgument).join(" ");
  return {
    command: connection.executable,
    args: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      String(connection.port),
      ...connection.identityFile ? ["-i", connection.identityFile] : [],
      "--",
      connection.host,
      remote
    ]
  };
}

// src/shared/ssh/SSHRuntime.ts
import { spawn as spawn2 } from "node:child_process";

// src/core/process/env.ts
var isWindows = process.platform === "win32";
function stripEnvironmentExportPrefix(line) {
  return line.replace(/^export[ \t]+/, "");
}
function parseEnvironmentVariables(input) {
  const result = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = stripEnvironmentExportPrefix(trimmed);
    const eqIndex = normalized.indexOf("=");
    if (eqIndex > 0) {
      const key = normalized.substring(0, eqIndex).trim();
      let value = normalized.substring(eqIndex + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (key) {
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
    }
  }
  return result;
}

// src/core/process/ManagedStdioProcess.ts
import {
  spawn as nodeSpawn
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import crossSpawn from "cross-spawn";

// src/core/process/windowsCmdShim.ts
function resolveWindowsCmdShimSpawnSpec(spec) {
  const command = spec.command.trim();
  if (!command || process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) {
    return {
      args: spec.args,
      command: spec.command,
      ...process.platform === "win32" && spec.killProcessTree ? { killProcessTree: true } : {}
    };
  }
  if (spec.args.some((value) => /[\r\n]/u.test(value))) {
    throw new Error(
      "Windows command shims cannot safely receive multiline arguments. Use a native executable or launch the underlying script directly."
    );
  }
  return {
    args: spec.args,
    command,
    killProcessTree: true
  };
}
function terminateSpawnedProcess(proc, signal, spawnProcess, spawnSpec) {
  if (process.platform !== "win32" || !spawnSpec?.killProcessTree || typeof proc.pid !== "number") {
    return proc.kill(signal);
  }
  try {
    const taskkill = spawnProcess("taskkill.exe", ["/pid", String(proc.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (isErrorEmitterLike(taskkill)) {
      taskkill.on("error", () => {
      });
    }
    return true;
  } catch {
    return proc.kill(signal);
  }
}
function isErrorEmitterLike(value) {
  return value !== null && typeof value === "object" && typeof value.on === "function";
}

// src/core/process/ManagedStdioProcess.ts
var DEFAULT_SIGKILL_TIMEOUT_MS = 3e3;
var DEFAULT_FINAL_SHUTDOWN_TIMEOUT_MS = 3e3;
var DEFAULT_STDERR_BUFFER_LIMIT = 8e3;
var spawn = crossSpawn;
var ManagedStdioProcess = class {
  constructor(options) {
    this.options = options;
    this.state = { kind: "unstarted" };
    this.closeListeners = /* @__PURE__ */ new Set();
    this.errorListeners = /* @__PURE__ */ new Set();
    this.exitListeners = /* @__PURE__ */ new Set();
    this.terminationListeners = /* @__PURE__ */ new Set();
    this.terminationNotified = false;
    this.resolvedSpawnSpec = null;
    this.shutdownPromise = null;
    this.stderrBuffer = "";
    this.stderrDecoder = new StringDecoder("utf8");
    this.stderrDataListener = null;
    this.handleError = (error) => {
      const state = this.state;
      if (state.kind === "running") {
        if (state.spawnConfirmed) state.error = error;
        else this.state = { kind: "ended", proc: state.proc, exit: { closed: false, code: null, error, signal: null } };
      } else if (state.kind === "ended") {
        state.exit = { ...state.exit, closed: false, error };
      }
      this.#notifyError(error);
    };
    this.handleSpawn = () => {
      if (this.state.kind === "running") this.state.spawnConfirmed = true;
    };
    this.handleExit = (code, signal) => {
      const error = this.#recordedError();
      this.state = { kind: "ended", proc: this.proc, exit: { closed: false, code, ...error ? { error } : {}, signal } };
      for (const listener of [...this.exitListeners]) {
        safelyNotify(() => listener(this.getExitState()));
      }
      this.#notifyTerminated(code, signal);
    };
    this.handleClose = (code, signal) => {
      this.#finalizeStderr();
      const error = this.#recordedError();
      this.state = { kind: "ended", proc: this.proc, exit: { closed: true, code, ...error ? { error } : {}, signal } };
      for (const listener of [...this.closeListeners]) {
        safelyNotify(() => listener(this.getExitState()));
      }
      this.#cleanupProcessListeners(this.proc);
      this.#clearLifecycleListeners();
    };
    this.#ownsProcessGroup = options.killProcessTree === true && process.platform !== "win32";
  }
  #ownsProcessGroup;
  get proc() {
    return this.state.kind === "unstarted" ? null : this.state.proc;
  }
  get alive() {
    return this.state.kind === "running";
  }
  get stdin() {
    return this.#requireProcess().stdin;
  }
  get stdout() {
    return this.#requireProcess().stdout;
  }
  get stderr() {
    return this.#requireProcess().stderr;
  }
  start() {
    if (this.state.kind !== "unstarted" || this.shutdownPromise) {
      return;
    }
    const resolvedSpawnSpec = resolveWindowsCmdShimSpawnSpec(this.options);
    this.resolvedSpawnSpec = resolvedSpawnSpec;
    let proc;
    try {
      const spawnProcess = this.options.directSpawn ? nodeSpawn : spawn;
      proc = spawnProcess(resolvedSpawnSpec.command, resolvedSpawnSpec.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: "pipe",
        windowsHide: true,
        ...this.#ownsProcessGroup ? { detached: true } : {},
        ...this.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}
      });
    } catch (error) {
      const spawnError = toError(error);
      this.state = { kind: "ended", proc: null, exit: { closed: true, code: null, error: spawnError, signal: null } };
      this.#notifyError(spawnError);
      this.#clearLifecycleListeners();
      throw spawnError;
    }
    const alive = (proc.exitCode === null || proc.exitCode === void 0) && (proc.signalCode === null || proc.signalCode === void 0) && !proc.killed;
    this.state = alive ? { kind: "running", proc, spawnConfirmed: typeof proc.pid === "number" } : { kind: "ended", proc, exit: { closed: false, code: proc.exitCode ?? null, signal: proc.signalCode ?? null } };
    this.stderrDataListener = (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        this.#appendStderr(this.stderrDecoder.write(chunk));
      } else if (chunk.length > 0) {
        this.#finalizeStderr();
        this.#appendStderr(chunk);
      }
    };
    proc.stderr.on("data", this.stderrDataListener);
    proc.on("spawn", this.handleSpawn);
    proc.on("error", this.handleError);
    proc.on("exit", this.handleExit);
    proc.on("close", this.handleClose);
  }
  isStarted() {
    return this.proc !== null;
  }
  isAlive() {
    return this.alive;
  }
  getExitState() {
    if (this.state.kind === "ended") return { ...this.state.exit };
    if (this.state.kind === "running" && this.state.error) {
      return { closed: false, code: null, error: this.state.error, signal: null };
    }
    return null;
  }
  /**
   * Notifies once, on the first error or exit. A non-clean exit is reported with `describe`, unless an
   * earlier error already explains it.
   */
  onTerminated(listener, describe) {
    const entry = { listener, describe };
    this.terminationListeners.add(entry);
    return () => {
      this.terminationListeners.delete(entry);
    };
  }
  getStderrSnapshot() {
    return this.stderrBuffer.trim();
  }
  onError(listener) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }
  onExit(listener) {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  shutdown() {
    if (!this.shutdownPromise) {
      const graceMs = this.options.stdinCloseGraceMs;
      this.shutdownPromise = graceMs !== void 0 && this.proc && this.alive ? this.#closeStdin(this.proc.stdin, graceMs).then(() => this.#terminate()) : this.#terminate();
    }
    return this.shutdownPromise;
  }
  /** A signal skips the child's own cleanup; on Windows it also stops only a WSL launcher, not its Linux command. */
  #closeStdin(stdin, graceMs) {
    return new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        offExit();
        resolve();
      };
      const timer = window.setTimeout(done, graceMs);
      const offExit = this.onExit(done);
      stdin.on("error", () => {
      }).end();
    });
  }
  #terminate() {
    const proc = this.proc;
    if (!proc || !this.alive) {
      if (proc) this.#killOwnedProcessGroup(proc, "SIGKILL");
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let killTimer = null;
      let finalTimer = null;
      let unsubscribeExit = null;
      let unsubscribeClose = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.#killOwnedProcessGroup(proc, "SIGKILL");
        if (killTimer !== null) window.clearTimeout(killTimer);
        if (finalTimer !== null) window.clearTimeout(finalTimer);
        unsubscribeExit?.();
        unsubscribeClose?.();
        resolve();
      };
      unsubscribeExit = this.onExit(finish);
      unsubscribeClose = this.onClose(finish);
      killTimer = window.setTimeout(() => {
        if (this.alive) {
          this.#killProcess(proc, "SIGKILL");
        }
        finalTimer = window.setTimeout(() => {
          const error = this.state.kind === "running" ? this.state.error : void 0;
          this.state = { kind: "ended", proc, exit: { closed: false, code: null, ...error ? { error } : {}, signal: null } };
          this.#cleanupProcessListeners(proc);
          destroyStdio(proc);
          this.#clearLifecycleListeners();
          finish();
        }, DEFAULT_FINAL_SHUTDOWN_TIMEOUT_MS);
      }, this.options.sigkillTimeoutMs ?? DEFAULT_SIGKILL_TIMEOUT_MS);
      this.#killProcess(proc, "SIGTERM");
    });
  }
  #requireProcess() {
    if (!this.proc) {
      throw new Error("Managed stdio process is not started");
    }
    return this.proc;
  }
  #killProcess(proc, signal) {
    try {
      if (this.#ownsProcessGroup) {
        return this.#killOwnedProcessGroup(proc, signal);
      }
      return terminateSpawnedProcess(proc, signal, spawn, this.resolvedSpawnSpec);
    } catch {
      return false;
    }
  }
  #killOwnedProcessGroup(proc, signal) {
    if (!this.#ownsProcessGroup || !proc.pid) return false;
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  #recordedError() {
    if (this.state.kind === "running") return this.state.error;
    return this.state.kind === "ended" ? this.state.exit.error : void 0;
  }
  #notifyError(error) {
    for (const listener of [...this.errorListeners]) {
      safelyNotify(() => listener(error));
    }
    this.#notifyTerminated(null, null, error);
  }
  #notifyTerminated(code, signal, error = this.#recordedError()) {
    if (this.terminationNotified) return;
    this.terminationNotified = true;
    const entries = [...this.terminationListeners];
    this.terminationListeners.clear();
    for (const { listener, describe } of entries) {
      const reported = error ?? (code === 0 && signal === null ? void 0 : describe(code, signal));
      safelyNotify(() => listener(reported));
    }
  }
  #cleanupProcessListeners(proc) {
    if (!proc) return;
    this.#finalizeStderr();
    proc.off("spawn", this.handleSpawn);
    proc.off("error", this.handleError);
    proc.off("exit", this.handleExit);
    proc.off("close", this.handleClose);
    if (this.stderrDataListener) {
      proc.stderr.off("data", this.stderrDataListener);
      this.stderrDataListener = null;
    }
  }
  #appendStderr(text) {
    const limit = this.options.stderrBufferLimit ?? DEFAULT_STDERR_BUFFER_LIMIT;
    const content = `${this.stderrBuffer}${text}`;
    const tail = content.slice(-limit);
    const cut = content.length - tail.length;
    this.stderrBuffer = cut > 0 && (content.codePointAt(cut - 1) ?? 0) > 65535 ? tail.slice(1) : tail;
  }
  #finalizeStderr() {
    this.#appendStderr(this.stderrDecoder.end());
  }
  #clearLifecycleListeners() {
    this.errorListeners.clear();
    this.exitListeners.clear();
    this.closeListeners.clear();
    this.terminationListeners.clear();
  }
};
function destroyStdio(proc) {
  for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
    try {
      stream.destroy();
    } catch {
    }
  }
}
function safelyNotify(callback) {
  try {
    callback();
  } catch {
  }
}
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// src/shared/ssh/SSHRuntime.ts
function createSSHSpawn(connection, environmentText) {
  return (options) => {
    const environment = {
      ...Object.fromEntries(Object.entries(options.env).filter(([key]) => /^(?:CLAUDE_AGENT_SDK_|CLAUDE_CODE_ENTRYPOINT$|MCP_TIMEOUT$)/u.test(key))),
      ...parseEnvironmentVariables(environmentText)
    };
    const spec = buildSSHCommand(connection, { command: connection.cliPath, args: options.args, environment });
    const child = spawn2(spec.command, spec.args, { stdio: "pipe", windowsHide: true });
    const abort = () => {
      child.kill("SIGTERM");
    };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    child.once("close", () => options.signal.removeEventListener("abort", abort));
    child.stderr.on("data", () => void 0);
    return child;
  };
}

// bridge/BridgeEngines.ts
var BridgeEngines = class {
  constructor(repository, claude, codex) {
    this.repository = repository;
    this.claude = claude;
    this.codex = codex;
  }
  repository;
  claude;
  codex;
  send(session, input) {
    return (session.state.provider === "codex" ? this.codex : this.claude).send(session, input);
  }
  stop(id) {
    this.claude.stop(id);
    this.codex.stop(id);
  }
  stopAll() {
    this.claude.stopAll();
    this.codex.stopAll();
  }
  approve(sessionId, id, allow) {
    const provider = this.repository.sessions.get(sessionId)?.state.provider;
    (provider === "codex" ? this.codex : this.claude).approve(sessionId, id, allow);
  }
};

// bridge/BridgeServer.ts
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

// src/remote/protocol.ts
var RemoteProtocolError = class extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
    this.name = "RemoteProtocolError";
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value) {
  if (!isRecord(value)) throw new RemoteProtocolError("Expected an object");
  return value;
}
function string(value) {
  if (typeof value !== "string") throw new RemoteProtocolError("Expected text");
  return value;
}
function readRemoteSession(value) {
  const source = record(value);
  if (!Array.isArray(source.messages) || !Array.isArray(source.approvals) || typeof source.running !== "boolean") {
    throw new RemoteProtocolError("Invalid remote session");
  }
  return {
    provider: source.provider === "codex" ? "codex" : "claude",
    model: typeof source.model === "string" ? source.model : "",
    id: string(source.id),
    title: string(source.title),
    running: source.running,
    error: string(source.error),
    messages: source.messages.map((value2) => {
      const message = record(value2);
      const role = message.role;
      if (role !== "user" && role !== "assistant" && role !== "tool") throw new RemoteProtocolError("Invalid message role");
      return { id: string(message.id), role, text: string(message.text) };
    }),
    approvals: source.approvals.map((value2) => {
      const approval = record(value2);
      return { id: string(approval.id), tool: string(approval.tool), input: string(approval.input) };
    })
  };
}

// bridge/BridgeServer.ts
async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 256 * 1024) throw new RemoteProtocolError("Request is too large");
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  return record(parsed);
}
function createBridgeServer(repository, engine, token) {
  const digest = (value) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const reply = (status, value) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    if (request.headers.origin || !timingSafeEqual(expected, digest(request.headers.authorization ?? ""))) {
      reply(401, { error: "Unauthorized" });
      return;
    }
    try {
      const route = request.url ?? "";
      if (route === "/v1/health" && request.method === "GET") {
        reply(200, { name: "KK-Nerodian", version: "0.1.0" });
        return;
      }
      if (route === "/v1/sessions") {
        if (request.method === "GET") {
          reply(200, [...repository.sessions.values()].map(({ state }) => ({ id: state.id, title: state.title, running: state.running })));
          return;
        }
        if (request.method === "POST") {
          const input2 = await body(request);
          if (input2.provider !== void 0 && input2.provider !== "claude" && input2.provider !== "codex") throw new RemoteProtocolError("Unknown provider");
          const session2 = repository.create(input2.provider === "claude" ? "claude" : "codex", typeof input2.model === "string" ? input2.model : "");
          try {
            await repository.save();
          } catch (error) {
            repository.sessions.delete(session2.state.id);
            throw error;
          }
          reply(200, session2.state);
          return;
        }
      }
      const match = /^\/v1\/sessions\/([a-zA-Z0-9-]+)(?:\/(send|stop|approve))?$/u.exec(route);
      const session = match?.[1] ? repository.sessions.get(match[1]) : void 0;
      if (!session) {
        reply(404, { error: "Session not found" });
        return;
      }
      if (!match?.[2] && request.method === "GET") {
        reply(200, session.state);
        return;
      }
      if (request.method !== "POST") {
        reply(405, { error: "Method not allowed" });
        return;
      }
      const input = await body(request);
      switch (match?.[2]) {
        case "send":
          await engine.send(session, { prompt: string(input.prompt), operationId: string(input.operationId), ...typeof input.model === "string" ? { model: input.model } : {} });
          reply(200, session.state);
          return;
        case "stop":
          engine.stop(session.state.id);
          reply(200, { stopped: true });
          return;
        case "approve":
          if (typeof input.allow !== "boolean") throw new RemoteProtocolError("Invalid approval");
          engine.approve(session.state.id, string(input.approvalId), input.allow);
          reply(200, { accepted: true });
          return;
        default:
          reply(404, { error: "Unknown route" });
          return;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      reply(error instanceof RemoteProtocolError || error instanceof SyntaxError ? 400 : 500, { error: error.message });
    }
  });
}

// bridge/ClaudeEngine.ts
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
var ClaudeEngine = class {
  constructor(repository, launch) {
    this.repository = repository;
    this.launch = launch;
  }
  repository;
  launch;
  runs = /* @__PURE__ */ new Map();
  approvals = /* @__PURE__ */ new Map();
  async send(session, input) {
    if (!await this.repository.accept(session, input)) return;
    const controller = new AbortController();
    this.runs.set(session.state.id, controller);
    void this.run(session, { prompt: input.prompt, controller });
  }
  approve(sessionId, approvalId, allow) {
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.sessionId !== sessionId) throw new RemoteProtocolError("Approval expired");
    this.approvals.delete(approvalId);
    pending.settle(allow);
  }
  stop(id) {
    this.runs.get(id)?.abort();
  }
  stopAll() {
    for (const controller of this.runs.values()) controller.abort();
  }
  permission(session, tool, input, signal) {
    const id = randomUUID();
    session.state = { ...session.state, approvals: [...session.state.approvals, { id, tool, input: JSON.stringify(input, null, 2) }] };
    return new Promise((resolve) => {
      const cancel = () => settle(false);
      const settle = (allow) => {
        signal.removeEventListener("abort", cancel);
        this.approvals.delete(id);
        session.state = { ...session.state, approvals: session.state.approvals.filter((approval) => approval.id !== id) };
        resolve(allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Denied by user" });
      };
      this.approvals.set(id, { sessionId: session.state.id, settle });
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }
  async run(session, run) {
    let streamId = randomUUID();
    let text = "";
    const publish = () => {
      const messages = session.state.messages.filter((message2) => message2.id !== streamId);
      const message = { id: streamId, role: "assistant", text };
      session.state = { ...session.state, messages: [...messages, message] };
    };
    try {
      const response = query({ prompt: run.prompt, options: {
        ...this.launch,
        abortController: run.controller,
        ...session.state.model ? { model: session.state.model } : {},
        ...session.nativeId ? { resume: session.nativeId } : {},
        permissionMode: "default",
        includePartialMessages: true,
        persistSession: true,
        canUseTool: (tool, input, options) => this.permission(session, tool, input, options.signal)
      } });
      for await (const message of response) {
        if ("session_id" in message && typeof message.session_id === "string") session.nativeId = message.session_id;
        switch (message.type) {
          case "stream_event":
            if (message.event.type === "message_start") {
              streamId = message.event.message.id;
              text = "";
            }
            if (message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
              text += message.event.delta.text;
              publish();
            }
            break;
          case "assistant": {
            streamId = message.message.id;
            text = message.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
            if (text) publish();
            break;
          }
          case "result":
            if (message.is_error) session.state = { ...session.state, error: message.subtype === "success" ? message.result : message.errors.join("\n") };
            break;
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      session.state = { ...session.state, error: run.controller.signal.aborted ? "" : error.message };
    } finally {
      this.runs.delete(session.state.id);
      session.state = { ...session.state, running: false, approvals: [] };
      try {
        await this.repository.save();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        session.state = { ...session.state, error: `Failed to save bridge history: ${error.message}` };
      }
    }
  }
};

// bridge/CodexEngine.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/providers/codex/runtime/CodexAppServerProcess.ts
var STDERR_BUFFER_LIMIT = 8192;
var CodexAppServerProcess = class {
  constructor(launchSpec) {
    this.exitCallbacks = [];
    this.process = new ManagedStdioProcess({
      args: launchSpec.args,
      command: launchSpec.command,
      cwd: launchSpec.spawnCwd,
      env: launchSpec.env,
      windowsVerbatimArguments: launchSpec.windowsVerbatimArguments,
      stderrBufferLimit: STDERR_BUFFER_LIMIT
    });
    this.process.onClose(({ code, signal }) => {
      for (const callback of [...this.exitCallbacks]) {
        try {
          callback(code, signal);
        } catch {
        }
      }
      this.exitCallbacks.length = 0;
    });
  }
  get stdin() {
    this.#assertStarted();
    return this.process.stdin;
  }
  get stdout() {
    this.#assertStarted();
    return this.process.stdout;
  }
  start() {
    this.process.start();
  }
  isAlive() {
    return this.process.isAlive();
  }
  getStderrSnapshot() {
    return this.process.getStderrSnapshot();
  }
  onExit(callback) {
    this.exitCallbacks.push(callback);
  }
  offExit(callback) {
    const index = this.exitCallbacks.indexOf(callback);
    if (index !== -1) this.exitCallbacks.splice(index, 1);
  }
  shutdown() {
    return this.process.shutdown();
  }
  #assertStarted() {
    if (!this.process.isStarted()) {
      throw new Error("Process not started");
    }
  }
};

// src/utils/jsonlLines.ts
import { StringDecoder as StringDecoder2 } from "node:string_decoder";

// src/utils/LineBuffer.ts
var LineBuffer = class {
  constructor(maxLength = Number.POSITIVE_INFINITY) {
    this.maxLength = maxLength;
    this.fragments = [];
    this.length = 0;
  }
  get bufferedLength() {
    return this.length;
  }
  push(text, onLine) {
    let start = 0;
    for (; ; ) {
      const end = text.indexOf("\n", start);
      const part = text.slice(start, end < 0 ? void 0 : end);
      this.length += part.length;
      if (this.length > this.maxLength) throw new Error("Line exceeded the size limit.");
      if (part) this.fragments.push(part);
      if (end < 0) return;
      onLine(this.take());
      start = end + 1;
    }
  }
  take() {
    const line = this.fragments.join("");
    this.fragments = [];
    this.length = 0;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }
};

// src/utils/jsonlLines.ts
function subscribeJSONLLines(input, onLine, onEnd, onError) {
  const lines = new LineBuffer();
  const decoder = new StringDecoder2("utf8");
  const handleData = (chunk) => {
    lines.push(decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk), onLine);
  };
  const handleEnd = () => {
    lines.push(decoder.end(), onLine);
    if (lines.bufferedLength > 0) onLine(lines.take());
    onEnd?.();
  };
  const handleError = (error) => {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  };
  input.on("data", handleData);
  input.on("end", handleEnd);
  input.on("close", handleEnd);
  input.on("error", handleError);
  return () => {
    input.off("data", handleData);
    input.off("end", handleEnd);
    input.off("close", handleEnd);
    input.off("error", handleError);
  };
}

// src/core/rpc/JSONRPCTransport.ts
var DEFAULT_TIMEOUT_MS = 3e4;
var JSONRPCTransportClosedError = class extends Error {
  constructor(message = "JSON-RPC transport closed") {
    super(message);
    this.name = "JsonRpcTransportClosedError";
  }
};
var JSONRPCErrorResponse = class extends Error {
  constructor(method, code, message, data) {
    super(message);
    this.method = method;
    this.code = code;
    this.data = data;
    this.name = "JsonRpcErrorResponse";
  }
};
var JSONRPCTransport = class {
  constructor(streams, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
    this.streams = streams;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.options = options;
    this.abortController = new AbortController();
    this.closeListeners = /* @__PURE__ */ new Set();
    this.disposed = false;
    this.nextId = 1;
    this.notificationHandlers = /* @__PURE__ */ new Map();
    this.pending = /* @__PURE__ */ new Map();
    this.unsubscribeInputLines = null;
    this.requestHandlers = /* @__PURE__ */ new Map();
    this.streamCloseTimer = null;
    this.streamUnsubscribers = [];
  }
  get signal() {
    return this.abortController.signal;
  }
  get isClosed() {
    return this.disposed;
  }
  start() {
    if (this.unsubscribeInputLines || this.disposed) return;
    this.unsubscribeInputLines = subscribeJSONLLines(
      this.streams.input,
      (line) => this.#handleLine(line),
      () => this.#closeFromStream("JSON-RPC input closed")
    );
    this.streamUnsubscribers.push(
      subscribeStreamEvent(this.streams.input, "error", (error) => {
        this.#closeFromUnknown(error, "JSON-RPC input error");
      }),
      subscribeStreamEvent(this.streams.output, "error", (error) => {
        this.#closeFromUnknown(error, "JSON-RPC output error");
      }),
      subscribeStreamEvent(this.streams.output, "close", () => {
        this.#closeFromStream("JSON-RPC output closed");
      })
    );
    this.unregisterClose = this.streams.onClose?.((error) => {
      if (!this.disposed) {
        this.dispose(error ?? new JSONRPCTransportClosedError());
      }
    });
  }
  onClose(listener) {
    if (this.disposed) return () => {
    };
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  onNotification(method, handler) {
    if (this.disposed) return () => {
    };
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = /* @__PURE__ */ new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.notificationHandlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.notificationHandlers.delete(method);
    };
  }
  onRequest(method, handler) {
    if (this.disposed) return () => {
    };
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) {
        this.requestHandlers.delete(method);
      }
    };
  }
  async request(method, params, options = {}) {
    this.start();
    if (this.disposed) throw new JSONRPCTransportClosedError();
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer;
      let onAbort;
      const cleanup = () => {
        if (timer !== void 0) window.clearTimeout(timer);
        if (onAbort && options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      };
      if (timeoutMs > 0) {
        timer = window.setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
        }, timeoutMs);
      }
      if (options.signal?.aborted) {
        cleanup();
        reject(new Error(`Request aborted: ${method}`));
        return;
      }
      if (options.signal) {
        onAbort = () => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`Request aborted: ${method}`));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, {
        cleanup,
        method,
        reject,
        resolve: (result) => resolve(result)
      });
      try {
        this.#sendRaw({ id, jsonrpc: "2.0", method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        const transportError = toError2(error);
        this.dispose(transportError);
        reject(transportError);
      }
    });
  }
  notify(method, params) {
    this.start();
    if (this.disposed) return;
    this.#trySendRaw({ jsonrpc: "2.0", method, params });
  }
  flush() {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      try {
        this.streams.output.write("", (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(toError2(error));
      }
    });
  }
  dispose(error = new JSONRPCTransportClosedError("JSON-RPC transport disposed")) {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    if (this.streamCloseTimer !== null) {
      window.clearTimeout(this.streamCloseTimer);
      this.streamCloseTimer = null;
    }
    this.unregisterClose?.();
    this.unregisterClose = void 0;
    while (this.streamUnsubscribers.length > 0) {
      this.streamUnsubscribers.pop()?.();
    }
    this.unsubscribeInputLines?.();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) {
      try {
        listener(error);
      } catch {
      }
    }
    this.closeListeners.clear();
    this.notificationHandlers.clear();
    this.requestHandlers.clear();
  }
  #closeFromUnknown(error, fallbackMessage) {
    if (this.disposed) return;
    this.dispose(error instanceof Error ? error : new JSONRPCTransportClosedError(fallbackMessage));
  }
  #closeFromStream(message) {
    if (this.disposed || this.streamCloseTimer !== null) return;
    const graceMs = this.options.streamCloseGraceMs ?? 0;
    const error = new JSONRPCTransportClosedError(message);
    if (!this.streams.onClose || graceMs <= 0) {
      this.dispose(error);
      return;
    }
    this.streamCloseTimer = window.setTimeout(() => {
      this.streamCloseTimer = null;
      this.dispose(error);
    }, graceMs);
  }
  #handleLine(line) {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord2(parsed)) return;
    const message = parsed;
    if ("id" in message && !("method" in message)) {
      this.#handleResponse(message);
      return;
    }
    if ("method" in message && "id" in message) {
      this.handleRequest(message);
      return;
    }
    if ("method" in message) this.handleNotification(message);
  }
  #handleResponse(message) {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) {
      pending.reject(new JSONRPCErrorResponse(
        pending.method,
        message.error.code,
        message.error.message,
        message.error.data
      ));
      return;
    }
    pending.resolve(message.result);
  }
  handleNotification(message) {
    const handlers = this.notificationHandlers.get(message.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      void Promise.resolve().then(() => handler(message.params)).catch(() => {
      });
    }
  }
  handleRequest(message) {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.#trySendRaw({
        error: {
          code: -32601,
          message: `Unhandled server request: ${message.method}`
        },
        id: message.id,
        jsonrpc: "2.0"
      });
      return;
    }
    const context = {
      method: message.method,
      requestId: message.id
    };
    void Promise.resolve().then(() => handler(message.params, context)).then(
      (result) => this.#trySendRaw({ id: message.id, jsonrpc: "2.0", result }),
      (error) => this.#trySendRaw({
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error"
        },
        id: message.id,
        jsonrpc: "2.0"
      })
    );
  }
  #sendRaw(message) {
    if (this.disposed) throw new JSONRPCTransportClosedError();
    this.streams.output.write(`${JSON.stringify(message)}
`);
  }
  #trySendRaw(message) {
    try {
      this.#sendRaw(message);
    } catch (error) {
      this.dispose(toError2(error));
    }
  }
};
function subscribeStreamEvent(stream, eventName, listener) {
  stream.on(eventName, listener);
  return () => {
    stream.off(eventName, listener);
  };
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toError2(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// src/providers/codex/runtime/CodexRPCTransport.ts
var DEFAULT_TIMEOUT_MS2 = 3e4;
var PROCESS_CLOSE_GRACE_MS = 3e3;
var CodexRPCResponseError = class extends Error {
  constructor(error) {
    super(error.message);
    this.name = "CodexRpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
};
var CodexRPCTransport = class {
  constructor(proc) {
    this.proc = proc;
    this.disposed = false;
    this.notificationHandlers = /* @__PURE__ */ new Map();
    this.notificationUnsubscribers = /* @__PURE__ */ new Map();
    this.serverRequestHandlers = /* @__PURE__ */ new Map();
    this.serverRequestUnsubscribers = /* @__PURE__ */ new Map();
    this.transport = null;
  }
  start() {
    if (this.transport || this.disposed) return;
    const transport = new JSONRPCTransport({
      input: this.proc.stdout,
      onClose: (listener) => {
        const exitHandler = () => {
          listener(new Error(this.#buildProcessExitMessage()));
        };
        this.proc.onExit(exitHandler);
        return () => this.proc.offExit(exitHandler);
      },
      output: this.proc.stdin
    }, DEFAULT_TIMEOUT_MS2, { streamCloseGraceMs: PROCESS_CLOSE_GRACE_MS });
    this.transport = transport;
    for (const [method, handler] of this.notificationHandlers) {
      this.#registerNotificationHandler(transport, method, handler);
    }
    for (const [method, handler] of this.serverRequestHandlers) {
      this.#registerServerRequestHandler(transport, method, handler);
    }
    transport.start();
  }
  async request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS2, signal) {
    if (this.disposed) throw new Error("Transport disposed");
    this.start();
    try {
      return await this.transport.request(method, params, { timeoutMs, signal });
    } catch (error) {
      if (error instanceof JSONRPCErrorResponse) {
        throw new CodexRPCResponseError({
          code: error.code,
          data: error.data,
          message: error.message
        });
      }
      throw error;
    }
  }
  notify(method, params) {
    if (this.disposed) return;
    this.start();
    this.transport.notify(method, params);
  }
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
    if (this.transport) {
      this.#registerNotificationHandler(this.transport, method, handler);
    }
  }
  onServerRequest(method, handler) {
    this.serverRequestHandlers.set(method, handler);
    if (this.transport) {
      this.#registerServerRequestHandler(this.transport, method, handler);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.#clearUnsubscribers(this.notificationUnsubscribers);
    this.#clearUnsubscribers(this.serverRequestUnsubscribers);
    this.transport?.dispose(new Error("Transport disposed"));
    this.transport = null;
    this.notificationHandlers.clear();
    this.serverRequestHandlers.clear();
  }
  #registerNotificationHandler(transport, method, handler) {
    this.notificationUnsubscribers.get(method)?.();
    this.notificationUnsubscribers.set(method, transport.onNotification(method, handler));
  }
  #registerServerRequestHandler(transport, method, handler) {
    this.serverRequestUnsubscribers.get(method)?.();
    this.serverRequestUnsubscribers.set(method, transport.onRequest(
      method,
      (params, context) => handler(context.requestId, params)
    ));
  }
  #clearUnsubscribers(unsubscribers) {
    for (const unsubscribe of unsubscribers.values()) unsubscribe();
    unsubscribers.clear();
  }
  #buildProcessExitMessage() {
    const stderr = this.proc.getStderrSnapshot();
    return stderr ? `App-server process exited

${stderr}` : "App-server process exited";
  }
};

// bridge/CodexEngine.ts
var CodexEngine = class {
  constructor(repository, launch) {
    this.repository = repository;
    this.launch = launch;
  }
  repository;
  launch;
  active = /* @__PURE__ */ new Map();
  approvals = /* @__PURE__ */ new Map();
  async send(session, input) {
    if (!await this.repository.accept(session, input)) return;
    void this.run(session, input.prompt);
  }
  stop(id) {
    const run = this.active.get(id);
    if (!run) return;
    run.cancelled = true;
    for (const [key, approval] of this.approvals) if (approval.sessionId === id) {
      approval.resolve(false);
      this.approvals.delete(key);
    }
    if (run.threadId && run.turnId) void run.transport.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId }).catch((error) => {
      run.session.state = { ...run.session.state, error: error instanceof Error ? error.message : String(error) };
    });
  }
  stopAll() {
    for (const id of this.active.keys()) this.stop(id);
  }
  approve(sessionId, id, allow) {
    const pending = this.approvals.get(id);
    if (!pending || pending.sessionId !== sessionId) throw new RemoteProtocolError("Approval expired");
    this.approvals.delete(id);
    pending.resolve(allow);
  }
  approval(session, method, params) {
    const id = randomUUID2();
    session.state = { ...session.state, approvals: [...session.state.approvals, { id, tool: method, input: JSON.stringify(params, null, 2) }] };
    return new Promise((resolve) => {
      this.approvals.set(id, { sessionId: session.state.id, resolve: (allow) => {
        session.state = { ...session.state, approvals: session.state.approvals.filter((item) => item.id !== id) };
        resolve({ decision: allow ? "accept" : "decline" });
      } });
    });
  }
  updateMessage(session, input) {
    const existing = session.state.messages.find((message2) => message2.id === input.id);
    const message = { id: input.id, role: "assistant", text: input.append ? (existing?.text ?? "") + input.text : input.text };
    session.state = { ...session.state, messages: [...session.state.messages.filter((item) => item.id !== input.id), message] };
  }
  async run(session, prompt) {
    const proc = new CodexAppServerProcess(this.launch);
    const transport = new CodexRPCTransport(proc);
    const run = { transport, session, threadId: session.nativeId, turnId: "", cancelled: false };
    this.active.set(session.state.id, run);
    const completed = new Promise((resolve) => {
      proc.onExit(() => resolve(proc.getStderrSnapshot() || "Codex app-server exited"));
      transport.onNotification("turn/completed", (value) => {
        const turn = record(record(value).turn);
        resolve(turn.status === "failed" ? JSON.stringify(turn.error ?? "Codex turn failed") : "");
      });
    });
    transport.onNotification("turn/started", (value) => {
      run.turnId = string(record(record(value).turn).id);
      if (run.cancelled) this.stop(session.state.id);
    });
    transport.onNotification("item/agentMessage/delta", (value) => {
      const item = record(value);
      this.updateMessage(session, { id: string(item.itemId), text: string(item.delta), append: true });
    });
    transport.onNotification("item/completed", (value) => {
      const item = record(record(value).item);
      if (item.type === "agentMessage" && typeof item.text === "string") this.updateMessage(session, { id: string(item.id), text: item.text, append: false });
      if (item.type === "commandExecution" && typeof item.aggregatedOutput === "string") session.state = {
        ...session.state,
        messages: [...session.state.messages, { id: string(item.id), role: "tool", text: item.aggregatedOutput }]
      };
    });
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
      transport.onServerRequest(method, (_id, params) => this.approval(session, method, params));
    }
    try {
      proc.start();
      transport.start();
      await transport.request("initialize", { clientInfo: { name: "kk-nerodian", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      transport.notify("initialized");
      const settings = {
        cwd: this.launch.workspace,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ...session.state.model ? { model: session.state.model } : {}
      };
      const response = record(await transport.request(session.nativeId ? "thread/resume" : "thread/start", {
        ...settings,
        ...session.nativeId ? { threadId: session.nativeId } : {}
      }));
      run.threadId = string(record(response.thread).id);
      session.nativeId = run.threadId;
      if (run.cancelled) return;
      const started = record(await transport.request("turn/start", { threadId: run.threadId, input: [{ type: "text", text: prompt, text_elements: [] }] }));
      run.turnId = string(record(started.turn).id);
      if (run.cancelled) this.stop(session.state.id);
      const error = await completed;
      if (error && !run.cancelled) session.state = { ...session.state, error };
    } catch (error) {
      session.state = { ...session.state, error: run.cancelled ? "" : error instanceof Error ? error.message : String(error) };
    } finally {
      this.active.delete(session.state.id);
      for (const [id, approval] of this.approvals) if (approval.sessionId === session.state.id) {
        approval.resolve(false);
        this.approvals.delete(id);
      }
      transport.dispose();
      await proc.shutdown();
      session.state = { ...session.state, running: false, approvals: [] };
      try {
        await this.repository.save();
      } catch (error) {
        session.state = { ...session.state, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
};

// bridge/SessionRepository.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
var SessionRepository = class {
  constructor(directory) {
    this.directory = directory;
  }
  directory;
  sessions = /* @__PURE__ */ new Map();
  writes = Promise.resolve();
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    let contents;
    try {
      contents = await readFile(path.join(this.directory, "sessions.json"), "utf8");
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const parsed = JSON.parse(contents);
    if (!Array.isArray(parsed)) throw new TypeError("Invalid bridge session store");
    for (const value of parsed) {
      const entry = record(value);
      const state = readRemoteSession(entry.state);
      if (!Array.isArray(entry.operations)) throw new TypeError("Invalid operation history");
      this.sessions.set(state.id, {
        state: { ...state, running: false, approvals: [], error: state.running ? "Bridge restarted. Send a message to continue." : state.error },
        nativeId: string(entry.nativeId),
        operations: entry.operations.map(string)
      });
    }
  }
  create(provider = "codex", model = "") {
    const state = { id: randomUUID3(), title: "New conversation", messages: [], running: false, error: "", approvals: [], provider, model };
    const session = { state, nativeId: "", operations: [] };
    this.sessions.set(state.id, session);
    return session;
  }
  save() {
    const snapshot = JSON.stringify([...this.sessions.values()]);
    const write = this.writes.then(async () => {
      const target = path.join(this.directory, "sessions.json");
      const temporary = `${target}.${randomUUID3()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 384 });
      await rename(temporary, target);
    });
    this.writes = write.catch(() => void 0);
    return write;
  }
  async accept(session, input) {
    if (session.operations.includes(input.operationId)) return false;
    if (session.state.running) throw new RemoteProtocolError("This session is already running");
    if (!input.prompt.trim() || input.prompt.length > 2e5) throw new RemoteProtocolError("Enter a message shorter than 200,000 characters");
    const previous = { ...session };
    session.state = {
      ...session.state,
      running: true,
      error: "",
      model: input.model ?? session.state.model,
      title: session.state.messages.length ? session.state.title : input.prompt.slice(0, 80),
      messages: [...session.state.messages, { id: randomUUID3(), role: "user", text: input.prompt }]
    };
    session.operations = [...session.operations.slice(-255), input.operationId];
    try {
      await this.save();
    } catch (error) {
      Object.assign(session, previous);
      throw error;
    }
    return true;
  }
};

// bridge/main.ts
async function main() {
  if (typeof window === "undefined") Object.defineProperty(globalThis, "window", { value: { setTimeout, clearTimeout } });
  const token = process.env.NERODIAN_TOKEN;
  const workspace = process.env.NERODIAN_WORKSPACE;
  const port = Number(process.env.NERODIAN_PORT ?? "17868");
  if (!token || token.length < 32 || token.startsWith("replace-")) throw new TypeError("Set NERODIAN_TOKEN to a random token of at least 32 characters");
  if (!workspace || !path2.isAbsolute(workspace) || !(await stat(workspace)).isDirectory()) throw new TypeError("Set NERODIAN_WORKSPACE to the absolute server workspace path");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Invalid NERODIAN_PORT");
  const cli = process.env.NERODIAN_CLAUDE_PATH ?? "claude";
  const ssh = process.env.NERODIAN_SSH_HOST;
  const connection = {
    ...DEFAULT_SSH_CONNECTION,
    enabled: true,
    host: ssh ?? "",
    port: Number(process.env.NERODIAN_SSH_PORT ?? "22"),
    remoteDirectory: process.env.NERODIAN_SSH_WORKSPACE ?? workspace,
    cliPath: cli,
    identityFile: process.env.NERODIAN_SSH_KEY ?? ""
  };
  const repository = new SessionRepository(process.env.NERODIAN_DATA_DIR ?? path2.join(workspace, ".kk-nerodian", "bridge"));
  await repository.load();
  const claude = new ClaudeEngine(repository, {
    cwd: ssh ? connection.remoteDirectory : workspace,
    pathToClaudeCodeExecutable: cli,
    ...ssh ? { spawnClaudeCodeProcess: createSSHSpawn(connection, "") } : {}
  });
  const codexPath = process.env.NERODIAN_CODEX_PATH ?? "codex";
  const codexArgs = ["app-server", "--listen", "stdio://"];
  const codexLaunch = ssh ? buildSSHCommand({ ...connection, cliPath: codexPath }, { command: codexPath, args: codexArgs, environment: {} }) : { command: codexPath, args: codexArgs };
  const codex = new CodexEngine(repository, {
    ...codexLaunch,
    spawnCwd: workspace,
    workspace: ssh ? connection.remoteDirectory : workspace,
    env: Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== void 0))
  });
  const engine = new BridgeEngines(repository, claude, codex);
  const server = createBridgeServer(repository, engine, token);
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`KK-Nerodian bridge listening on 127.0.0.1:${port}
`);
  });
  const shutdown = () => {
    engine.stopAll();
    server.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
});
