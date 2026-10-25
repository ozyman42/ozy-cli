import { Effect, pipe } from "effect";
import { effunct } from "effective-modules";
import { makeCommand } from "@/common/command";
import { log } from "@/common/log";
import { cliModules } from "@/modules/cli";
import { CloudflareImpl } from "@/modules/cli/cloudflare/impl";
import { OSPlatformImpl } from "@/modules/common/os-platform/impl";

/**
 * Permissions a Jive app deployment needs: the Worker and its stateful bindings on the account, plus the
 * zone read and route edit that attaching a hostname requires.
 */
const PERMISSION_GROUP_KEYS = [
  "com.cloudflare.edge.worker.script.update",
  "com.cloudflare.edge.worker.kv.namespace.update",
  "com.cloudflare.api.account.d1.update",
  "com.cloudflare.api.account.zone.read",
  "com.cloudflare.edge.worker.route.update",
];

export const token = makeCommand(
  "token",
  "create a Cloudflare API token by driving a browser, and print it",
  function* () {
    // No inputs. Which account the token is for is the one decision here, and it is made by clicking it
    // in the dashboard rather than by looking up an id and exporting it first.
    const created = yield* pipe(
      effunct(function* () {
        const cloudflare = yield* cliModules.Cloudflare;
        return yield* cloudflare.createApiToken({
          name: `jive-deploy-${new Date().toISOString().slice(0, 10)}`,
          permissionGroupKeys: PERMISSION_GROUP_KEYS,
        });
      })(),
      Effect.provide(CloudflareImpl.Layer),
      Effect.provide(OSPlatformImpl.Layer),
    );

    log("");
    log(created.token);
    log("");
    log(`Account ${created.accountId}`);
  },
);
