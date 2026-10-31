import { Effect, pipe } from "effect";
import { effunct } from "effective-modules";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeCommand } from "@/common/command";
import { log } from "@/common/log";
import { cliModules } from "@/modules/cli";
import { CloudflareImpl } from "@/modules/cli/cloudflare/impl";
import type { TemplatePermission } from "@/modules/cli/cloudflare/interface";
import { OSPlatformImpl } from "@/modules/common/os-platform/impl";

/**
 * Permissions a Jive app deployment needs, one per Cloudflare API family `@jive-sh/app`'s deploy calls:
 * Worker upload and secrets, KV namespaces, D1 databases, zone lookup, and attaching routes.
 */
const PERMISSIONS: ReadonlyArray<TemplatePermission> = [
  { key: "workers_scripts", type: "edit" },
  { key: "workers_kv_storage", type: "edit" },
  { key: "d1", type: "edit" },
  { key: "zone", type: "read" },
  { key: "workers_routes", type: "edit" },
];

/** Read by `~/.jive/set-secret`; the token never reaches a terminal or an argument list. */
const TOKEN_FILE = join(homedir(), ".jive", "cloudflare-token.json");

/** Written beside the target and renamed over it, so the file is never readable by others or half-written. */
const writeTokenFile = (token: string): Effect.Effect<void, string> =>
  Effect.tryPromise({
    try: async () => {
      const staging = `${TOKEN_FILE}.${process.pid}.tmp`;
      await mkdir(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
      await writeFile(staging, `${JSON.stringify({ token })}\n`, { mode: 0o600, flag: "wx" });
      await chmod(staging, 0o600);
      await rename(staging, TOKEN_FILE);
    },
    catch: (cause) => `Could not write ${TOKEN_FILE}: ${String(cause)}`,
  });

export const token = makeCommand(
  "token",
  `create a Cloudflare API token by driving a browser, and write it to ${TOKEN_FILE}`,
  function* () {
    // No inputs. Which account the token is for is the one decision here, and it is made by clicking it
    // in the dashboard rather than by looking up an id and exporting it first.
    const created = yield* pipe(
      effunct(function* () {
        const cloudflare = yield* cliModules.Cloudflare;
        return yield* cloudflare.createApiToken({
          name: `jive-deploy-${new Date().toISOString().slice(0, 10)}`,
          permissions: PERMISSIONS,
        });
      })(),
      Effect.provide(CloudflareImpl.Layer),
      Effect.provide(OSPlatformImpl.Layer),
    );

    yield* writeTokenFile(created.token);
    log(`Token for account ${created.accountId} written to ${TOKEN_FILE}`);
  },
);
