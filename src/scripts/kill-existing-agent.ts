import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const pidFile = path.resolve(import.meta.dir, "../../dist/ozy-signing-agent.pid");

function isProcessRunning(pid: number): boolean {
  try {
    // signal 0 sends nothing; it only checks whether the PID exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (existsSync(pidFile)) {
  const pid = parseInt(readFileSync(pidFile, "utf-8"));
  if (isProcessRunning(pid)) {
    console.log(`Killing agent on PID ${pid}`);
    process.kill(pid, "SIGTERM");
  }
}
