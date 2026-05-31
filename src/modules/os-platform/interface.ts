import { Effect } from "effect";

export interface IOSPlatform {
  openBrowserWindow(url: string): Effect.Effect<void, never>;
  writeRestrictedFile(path: string, content: string): Effect.Effect<void, string>;
  startSocketServer(socketPath: string, onData: (data: Buffer) => Promise<Buffer>): Effect.Effect<void, string>;
}
