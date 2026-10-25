import { Option } from "effect";
import type { EffectGen } from "effective-modules";
import { dirname } from "node:path";
import { daemonStatuses, type DaemonStatus } from "jive-abstract-library";
import { makeCommand } from "@/common/command";
import { log } from "@/common/log";

/**
 * Every Jive daemon on this machine, not just ozy's own.
 *
 * The registry is shared across packages, so this lists whatever is registered — which is the point of
 * having it: a daemon left behind by a package you have forgotten installing is exactly the thing you
 * cannot otherwise see.
 */

function describeState(status: DaemonStatus): string {
  const pid = Option.match(status.pid, { onNone: () => "", onSome: (value) => ` (pid ${value})` });
  return `${status.state}${pid}`;
}

function* daemonsAction(): EffectGen<void, string> {
  const statuses = yield* daemonStatuses;
  if (statuses.length === 0) {
    log("No Jive daemons are registered.");
    return;
  }

  log(`${statuses.length} Jive daemon${statuses.length === 1 ? "" : "s"} registered:`);
  for (const status of statuses) {
    const { registration } = status;
    log("");
    log(`  ${registration.name} — ${registration.packageName}`);
    log(`    status          ${describeState(status)}`);
    log(`    executable dir  ${dirname(registration.executable)}`);
    log(`    working dir     ${registration.workingDirectory}`);
    log(`    log             ${registration.logPath}`);
    log(`    id              ${registration.id}`);
    if (!status.executableExists) {
      // The orphan case: the package was removed without its registration going with it, so the service
      // manager is starting something that no longer exists.
      log(`    ⚠ ${registration.executable} does not exist — this registration is stale`);
    }
  }
}

export const daemons = makeCommand(
  "daemons",
  "list every Jive daemon registered on this machine, with where its executable lives",
  daemonsAction,
);
