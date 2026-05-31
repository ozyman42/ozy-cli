import { Effect } from "effect";
import { registerVirtualHIDMac } from "./mac";
import { registerVirtualHIDLinux } from "./linux";
import { registerVirtualHIDWindows } from "./windows";

export function registerVirtualHID(
  onMessage: (data: Buffer) => Effect.Effect<Buffer>
): Effect.Effect<void, string> {
  if (process.platform === 'darwin') return registerVirtualHIDMac(onMessage);
  if (process.platform === 'win32') return registerVirtualHIDWindows(onMessage);
  return registerVirtualHIDLinux(onMessage);
}
