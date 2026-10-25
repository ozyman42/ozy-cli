import { appendFileSync, readFileSync } from "node:fs";
import { Effect, Layer, pipe } from "effect";
import { exitWhenUninstalled } from "jive-abstract-library";
import { OSPlatformImpl } from "@/modules/common/os-platform/impl";
import { CryptoImpl } from "@/modules/common/crypto/impl";
import { KeyMapStoreImpl } from "@/modules/common/kep-map-store/impl";
import { SSHConfigImpl } from "@/modules/common/ssh-config/impl";
import { SSHAgentImpl } from "@/modules/ssh-agent/ssh-agent/impl";
import { SessionImpl } from "@/modules/ssh-agent/session/impl";
import { AGENT_LOG_FILE_PATH, AGENT_PID_FILE_PATH, AGENT_PORT_FILE_PATH, AGENT_SOCK_FILE_PATH } from "@/common/constants";
import { rmSync } from "node:fs";

/**
 * Stand down if another agent of this installed copy already holds the socket.
 *
 * Each installed copy has its own socket and pidfile, but one copy can still start two agents: its
 * registered daemon, and the one `ozy git setup` spawns when it cannot reach an agent. Only one can own the
 * socket. The loser exiting zero is what stops the service manager restarting it forever; it is also why
 * this runs before anything below, since the cleanup handler deletes those files unconditionally and a late
 * exit would take the incumbent's socket with it.
 */
function incumbentAgentPid(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(AGENT_PID_FILE_PATH, "utf-8"), 10);
    if (!Number.isInteger(pid) || pid === process.pid) return undefined;
    // Signal 0 sends nothing; it only asks whether the process exists.
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

const incumbent = incumbentAgentPid();
if (incumbent !== undefined) {
  process.stderr.write(`ozy-signing-agent ${incumbent} already holds ${AGENT_SOCK_FILE_PATH} — standing down\n`);
  process.exit(0);
}

// Takes this daemon's registration away with it if this copy of the package is ever uninstalled.
exitWhenUninstalled();

const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);

function logToFile(...args: any[]) {
  try { 
    appendFileSync(AGENT_LOG_FILE_PATH, args.map(arg => {
      try { return JSON.stringify(arg) }
      catch(e) { return String(e); }
    }).join(' ') + '\n'); 
  } catch {}
}

console.log = (...args: any[]) => { logToFile(...args); origLog(...args); };
console.error = (...args: any[]) => { logToFile(...args); origError(...args); };
console.warn = (...args: any[]) => { logToFile(...args); origWarn(...args); };

function cleanup() {
  try { rmSync(AGENT_PID_FILE_PATH); } catch {}
  try { rmSync(AGENT_PORT_FILE_PATH); } catch {}
  try { rmSync(AGENT_SOCK_FILE_PATH); } catch {}
}

process.on("exit", cleanup);
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });

pipe(
  SSHAgentImpl.ServiceLayer,
  Layer.provideMerge(SessionImpl.makeRpcLayer()),
  Layer.provideMerge(KeyMapStoreImpl.Layer),
  Layer.provideMerge(SSHConfigImpl.Layer),
  Layer.provideMerge(CryptoImpl.Layer),
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.launch,
  Effect.runPromise
);
