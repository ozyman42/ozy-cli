import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const pidFile = path.resolve(import.meta.dir, "../../dist/ozy-signing-agent.pid");

if (existsSync(pidFile)) {
  const pid = parseInt(readFileSync(pidFile, "utf-8"));
  console.log(`Killing agent on PID ${pid}`);
  process.kill(pid, "SIGTERM");
}
