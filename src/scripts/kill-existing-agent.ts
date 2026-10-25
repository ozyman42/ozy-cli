import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { AGENT_PID_FILE_NAME } from "@/common/constants";

// The agent writes its pidfile beside its own binary. This script runs under `bun`, so the constants'
// "beside the tool" would mean beside bun; the local build's binaries are in dist/base/bin.
const pidFile = path.resolve(import.meta.dir, "../../dist/base/bin", AGENT_PID_FILE_NAME);

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
