import { Effect } from "effect";
import type { Option } from "effect";
import type { EffectGen } from "effective-modules";

export type ProcessStdio = "pipe" | "inherit" | "ignore";

export interface SpawnProcessInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: ProcessStdio;
  readonly stdout?: ProcessStdio;
  readonly stderr?: ProcessStdio;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DetachedProcess {
  readonly pid: number;
}

export interface CallerProcess {
  pid: number;
  command: string;
  directory: Option.Option<string>;
}

export interface IOSPlatform {
  /** Runs a host process to completion with explicit stdio behavior. */
  spawnProcess(input: SpawnProcessInput): EffectGen<ProcessResult, string>;
  /** Starts a host process and releases it from this process lifecycle. */
  spawnDetachedProcess(input: SpawnProcessInput): EffectGen<DetachedProcess, string>;
  openBrowserWindow(url: string): Effect.Effect<void, never>;
  writeRestrictedFile(path: string, content: string): Effect.Effect<void, string>;
  startSocketServer(socketPath: string, onData: (data: Buffer, callerChain: CallerProcess[]) => EffectGen<Buffer>): EffectGen<void, string>;
  registerVirtualHID(onMessage: (data: Buffer) => Effect.Effect<Buffer>): EffectGen<void, string>;
  /** Reads this process's current working directory. */
  getCurrentDirectory(): Effect.Effect<string, never>;
  /** Changes this process's current working directory. */
  changeDirectory(path: string): Effect.Effect<void, string>;
  /** Prompts on the inherited terminal for a single line of input, showing promptText first. */
  promptInput(promptText: string): EffectGen<string, string>;
}
