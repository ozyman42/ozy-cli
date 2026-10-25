import { Effect } from "effect";
import type { EffectGen } from "effective-modules";

export function* registerVirtualHIDLinux(
  _onMessage: (data: Buffer) => Effect.Effect<Buffer>
): EffectGen<void, string> {
  return yield* Effect.fail('registerVirtualHID is not yet supported on Linux');
}
