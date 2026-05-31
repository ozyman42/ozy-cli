import { Effect } from "effect";
import { writeFileSync, existsSync, unlinkSync } from "node:fs";
import * as net from "node:net";
import { implementing } from "effective-modules";
import type { IOSPlatform } from "./interface";
import { commonModules } from "../common-modules";

const openCmd = process.platform === 'darwin' ? 'open'
  : process.platform === 'linux' ? 'xdg-open'
  : 'start';

const isWindows = process.platform === 'win32';

function openBrowserWindow(url: string): Effect.Effect<void, never> {
  return Effect.sync(() => { Bun.spawnSync([openCmd, url]); });
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

function startSocketServer(socketPath: string, onData: (data: Buffer) => Promise<Buffer>): Effect.Effect<void, string> {
  return Effect.try({
    try: () => {
      if (existsSync(socketPath)) unlinkSync(socketPath);
      if (isWindows) {
        const pipePath = `\\\\.\\pipe\\${socketPath.replace(/[/\\:]/g, '-')}`;
        const server = net.createServer((socket) => {
          socket.on('data', async (data) => socket.write(await onData(data)));
        });
        server.listen(pipePath);
      } else {
        Bun.listen({
          unix: socketPath,
          socket: {
            async data(socket, data) { socket.write(await onData(Buffer.from(data))); },
          },
        });
      }
    },
    catch: (e) => `Failed to start socket server at ${socketPath}: ${e instanceof Error ? e.message : String(e)}`,
  });
}

export class OSPlatformImpl extends implementing(commonModules.OSPlatform) implements IOSPlatform {
  openBrowserWindow(url: string) { return openBrowserWindow(url); }
  writeRestrictedFile(path: string, content: string) { return writeRestrictedFile(path, content); }
  startSocketServer(socketPath: string, onData: (data: Buffer) => Promise<Buffer>) { return startSocketServer(socketPath, onData); }
}
