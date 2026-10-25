import { Effect } from "effect";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import * as net from "node:net";
import { effunct, implementing, type EffectGen } from "effective-modules";
import type { IOSPlatform, CallerProcess, DetachedProcess, ProcessResult, SpawnProcessInput } from "./interface";
import { resolveCallerChainUnix, resolveCallerChainWindows } from "./caller-info";
import { commonModules } from "@/modules/common";
import { registerVirtualHID } from "./virtual-hid";
import { log } from "@/common/log";

const isWindows = process.platform === 'win32';

function openBrowserCommand(url: string): string[] {
  if (process.platform === 'darwin') return ['open', url];
  if (process.platform === 'linux') return ['xdg-open', url];
  // `start` is a cmd.exe builtin. The empty string is the window title slot.
  if (isWindows) return ['cmd.exe', '/c', 'start', '', url];
  // TODO: use exhaustive matching
  throw new Error("Unknown platform");
}

function openBrowserWindow(url: string): Effect.Effect<void, never> {
  return Effect.sync(() => { Bun.spawnSync(openBrowserCommand(url)); });
}

function writeRestrictedFile(path: string, content: string): Effect.Effect<void, string> {
  return Effect.try({
    try: () => {
      if (isWindows) {
        writeFileSync(path, content);
        const result = Bun.spawnSync(['icacls', path, '/inheritance:r', '/grant:r', `${process.env['USERNAME']}:(R,W)`]);
        if (result.exitCode !== 0)
          throw new Error(`icacls failed with exit code ${result.exitCode}`);
      } else {
        writeFileSync(path, content, { mode: 0o600 });
      }
    },
    catch: (e) => `Failed to write restricted file ${path}: ${e instanceof Error ? e.message : String(e)}`,
  });
}

function getCurrentDirectory(): Effect.Effect<string, never> {
  return Effect.sync(() => process.cwd());
}

function changeDirectory(path: string): Effect.Effect<void, string> {
  return Effect.try({
    try: () => { process.chdir(path); },
    catch: (e) => `Failed to change directory to ${path}: ${e instanceof Error ? e.message : String(e)}`,
  });
}

function* promptInput(promptText: string): EffectGen<string, string> {
  return yield* Effect.tryPromise({
    try: () => new Promise<string>(resolve => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(promptText, answer => {
        rl.close();
        resolve(answer.trim());
      });
    }),
    catch: (e) => `Failed to read input: ${e instanceof Error ? e.message : String(e)}`,
  });
}

function processCommand(input: SpawnProcessInput): string[] {
  return [input.command, ...(input.args ?? [])];
}

function spawnOptions(input: SpawnProcessInput) {
  return {
    cwd: input.cwd,
    env: input.env,
    stdin: input.stdin ?? "ignore",
    stdout: input.stdout ?? "pipe",
    stderr: input.stderr ?? "pipe",
  } as const;
}

function* spawnProcess(input: SpawnProcessInput): EffectGen<ProcessResult, string> {
  return yield* Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(processCommand(input), spawnOptions(input));
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
        proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
      ]);
      return { exitCode, stdout, stderr };
    },
    catch: (e) => `Failed to run ${input.command}: ${e instanceof Error ? e.message : String(e)}`,
  });
}

function* spawnDetachedProcess(input: SpawnProcessInput): EffectGen<DetachedProcess, string> {
  return yield* Effect.try({
    try: () => {
      const proc = Bun.spawn(processCommand(input), spawnOptions(input));
      proc.unref();
      return { pid: proc.pid };
    },
    catch: (e) => `Failed to start ${input.command}: ${e instanceof Error ? e.message : String(e)}`,
  });
}

function makeConnectionHandler(onData: (data: Buffer, callerChain: CallerProcess[]) => EffectGen<Buffer>, resolveChain: (socket: net.Socket) => CallerProcess[]) {
  return (socket: net.Socket) => {
    let callerChain: CallerProcess[];
    try {
      callerChain = resolveChain(socket);
    } catch (e) {
      log(`[socket-server] ERROR: Failed to get caller info — closing connection. Reason: ${e instanceof Error ? e.message : String(e)}`);
      socket.destroy();
      return;
    }
    socket.on('data', async (data) => {
      try {
        socket.write(await Effect.runPromise(effunct(onData)(data, callerChain)));
      } catch (e) {
        log(`[socket-server] ERROR in onData: ${e instanceof Error ? e.message : String(e)}`);
        socket.destroy();
      }
    });
  };
}

export class OSPlatformImpl extends implementing(commonModules.OSPlatform) implements IOSPlatform {
  *spawnProcess(input: SpawnProcessInput) { return yield* spawnProcess(input); }
  *spawnDetachedProcess(input: SpawnProcessInput) { return yield* spawnDetachedProcess(input); }
  openBrowserWindow(url: string) { return openBrowserWindow(url); }
  writeRestrictedFile(path: string, content: string) { return writeRestrictedFile(path, content); }
  *startSocketServer(socketPath: string, onData: (data: Buffer, callerChain: CallerProcess[]) => EffectGen<Buffer>): EffectGen<void, string> {
    return yield* Effect.try({
      try: () => {
        if (existsSync(socketPath)) unlinkSync(socketPath);
        if (isWindows) {
          const pipePath = `\\\\.\\pipe\\${socketPath.replace(/[/\\:]/g, '-')}`;
          const server = net.createServer(makeConnectionHandler(onData, (socket) => {
            const remotePid = (socket as any)._handle?.remotePid as number | undefined;
            if (remotePid == null) throw new Error('socket._handle.remotePid unavailable on this Windows/Bun version');
            return resolveCallerChainWindows(remotePid);
          }));
          server.listen(pipePath);
        } else {
          const server = net.createServer(makeConnectionHandler(onData, (socket) => {
            const fd = (socket as any)._handle?.fd as number | undefined;
            if (fd == null) throw new Error('socket._handle.fd unavailable — cannot resolve peer PID');
            return resolveCallerChainUnix(fd);
          }));
          server.listen(socketPath);
        }
      },
      catch: (e) => `Failed to start socket server at ${socketPath}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  registerVirtualHID(onMessage: (data: Buffer) => Effect.Effect<Buffer>) { return registerVirtualHID(onMessage); }
  getCurrentDirectory() { return getCurrentDirectory(); }
  changeDirectory(path: string) { return changeDirectory(path); }
  *promptInput(promptText: string) { return yield* promptInput(promptText); }
}
