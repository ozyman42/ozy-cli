import { Effect } from "effect";
import type { EffectGen } from "effective-modules";
import { registerVirtualHIDMac } from "./mac";
import { registerVirtualHIDLinux } from "./linux";
import { registerVirtualHIDWindows } from "./windows";

export function* registerVirtualHID(
  onMessage: (data: Buffer) => Effect.Effect<Buffer>
): EffectGen<void, string> {
  if (process.platform === 'darwin') return yield* registerVirtualHIDMac(onMessage);
  if (process.platform === 'win32') return yield* registerVirtualHIDWindows(onMessage);
  return yield* registerVirtualHIDLinux(onMessage);
}
