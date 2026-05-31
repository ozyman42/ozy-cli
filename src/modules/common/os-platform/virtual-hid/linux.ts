import { Effect } from "effect";

export function registerVirtualHIDLinux(
  _onMessage: (data: Buffer) => Effect.Effect<Buffer>
): Effect.Effect<void, string> {
  return Effect.fail('registerVirtualHID is not yet supported on Linux');
}
