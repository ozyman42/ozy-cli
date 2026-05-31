import { Effect } from "effect";
import type { Option } from "effect";
import type { EffectGen } from "effective-modules";

export interface CallerProcess {
  pid: number;
  command: string;
  directory: Option.Option<string>;
}

export interface IOSPlatform {
  openBrowserWindow(url: string): Effect.Effect<void, never>;
  writeRestrictedFile(path: string, content: string): Effect.Effect<void, string>;
  startSocketServer(socketPath: string, onData: (data: Buffer, callerChain: CallerProcess[]) => EffectGen<Buffer>): EffectGen<void, string>;
  registerVirtualHID(onMessage: (data: Buffer) => Effect.Effect<Buffer>): Effect.Effect<void, string>;
}
