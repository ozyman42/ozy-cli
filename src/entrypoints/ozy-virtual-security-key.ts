import { Effect } from "effect";
import { appendFileSync } from "node:fs";
import { commonModules } from "@/modules/common";
import { OSPlatformImpl } from "@/modules/common/os-platform/impl";
import { VIRTUAL_KEY_LOG_FILE_PATH } from "@/common/constants";

const program = Effect.gen(function* () {
  const platform = yield* commonModules.OSPlatform;
  yield* platform.registerVirtualHID((data) =>
    Effect.sync(() => {
      appendFileSync(VIRTUAL_KEY_LOG_FILE_PATH, `[vhid] received ${data.length} bytes: ${data.toString('hex')}\n`);
      return Buffer.alloc(64);
    })
  );
  yield* Effect.never;
}).pipe(Effect.provide(OSPlatformImpl.Layer));

Effect.runPromise(program).catch(e => {
  console.error('Virtual security key failed:', e);
  process.exit(1);
});
