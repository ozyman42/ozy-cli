import { Effect } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { appendFileSync } from "node:fs";
import { commonModules, type CommonModules } from "@/modules/common";
import { OSPlatformImpl } from "@/modules/common/os-platform/impl";
import { VIRTUAL_KEY_LOG_FILE_PATH } from "@/common/constants";

function* program(): EffectGen<void, string, CommonModules.OSPlatform> {
  const platform = yield* commonModules.OSPlatform;
  yield* platform.registerVirtualHID((data) =>
    Effect.sync(() => {
      appendFileSync(VIRTUAL_KEY_LOG_FILE_PATH, `[vhid] received ${data.length} bytes: ${data.toString('hex')}\n`);
      return Buffer.alloc(64);
    })
  );
  yield* Effect.never;
}

Effect.runPromise(effunct(program)().pipe(Effect.provide(OSPlatformImpl.Layer))).catch(e => {
  console.error('Virtual security key failed:', e);
  process.exit(1);
});
