import { existsSync, readFileSync } from "node:fs";
import { AGENT_PID_FILE_PATH } from "@/common/constants";

// Read from the one place the agent writes it. This used to resolve a path under dist/, which the agent
// stopped using when its state moved to ~/.ozy to keep the socket under the 104-byte sun_path limit — so
// the script had been silently finding nothing to kill.
const pidFile = AGENT_PID_FILE_PATH;

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
