import { appendFileSync } from "node:fs";
import { Effect, Layer, pipe } from "effect";
import { OSPlatformImpl } from "@/modules/common/os-platform/impl";
import { CryptoImpl } from "@/modules/common/crypto/impl";
import { KeyMapStoreImpl } from "@/modules/common/kep-map-store/impl";
import { SSHConfigImpl } from "@/modules/common/ssh-config/impl";
import { SSHAgentImpl } from "@/modules/ssh-agent/ssh-agent/impl";
import { SessionImpl } from "@/modules/ssh-agent/session/impl";
import { AGENT_LOG_FILE_PATH, AGENT_PID_FILE_PATH, AGENT_PORT_FILE_PATH, AGENT_SOCK_FILE_PATH } from "@/common/constants";
import { rmSync } from "node:fs";

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
