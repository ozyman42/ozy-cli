import * as path from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { version, name } from "../../package.json";

export const PACKAGE_NAME = name;
export const FUTURE_TOOL_NAME = "jive";
export const JIVE_GITHUB_CLIENT_ID = 'Ov23liKYxk1Ag7SsNhbP';
export const JIVE_GITHUB_CLIENT_SECRET = 'e2901fbe93c591e7a53a903e70490ff87e998159';
const CLI_DIR = path.dirname(process.execPath);
const commandPath = (commandName: string) =>
  path.resolve(CLI_DIR, process.platform === "win32" ? `${commandName}.exe` : commandName);

/** Everything the tool keeps at runtime lives next to it, so each installed copy has its own agent. */
const besideTool = (fileName: string) => path.resolve(CLI_DIR, fileName);
export const CLI_CMD_NAME = "ozy";
export const AGENT_CMD_NAME = "ozy-signing-agent";

/**
 * macOS caps a unix socket path at 104 bytes (`sun_path`; Linux allows 108). Where the tool is installed is
 * not ours to choose, and a global install that links a development checkout put the socket at 106 bytes,
 * so the agent could not bind. Only then does the socket move to `~/.ozy`, under a name derived from the
 * tool's directory, so each installed copy still gets its own agent.
 */
const MAX_SOCKET_PATH_BYTES = 104;
function agentSocketPath(): string {
  const beside = besideTool(`${AGENT_CMD_NAME}.sock`);
  if (Buffer.byteLength(beside) < MAX_SOCKET_PATH_BYTES) return beside;
  const fallbackDir = path.resolve(homedir(), ".ozy");
  mkdirSync(fallbackDir, { recursive: true });
  const copy = createHash("sha256").update(CLI_DIR).digest("hex").slice(0, 10);
  return path.resolve(fallbackDir, `${AGENT_CMD_NAME}.${copy}.sock`);
}
export const AGENT_CMD_PATH = commandPath(AGENT_CMD_NAME);
export const CLI_CMD_PATH = commandPath(CLI_CMD_NAME);
export const AGENT_SOCK_FILE_PATH = agentSocketPath();
export const AGENT_LOG_FILE_PATH = besideTool(`${AGENT_CMD_NAME}.log`);
export const AGENT_PID_FILE_PATH = besideTool(`${AGENT_CMD_NAME}.pid`);
export const AGENT_PORT_FILE_PATH = besideTool(`${AGENT_CMD_NAME}.port`);
export const CRED_ID_COMMENT_PREFIX = 'credentialId:';
export const CURRENT_VERSION = version;
export const VIRTUAL_KEY_CMD_NAME = "ozy-virtual-security-key";
export const SSH_KEYGEN_CMD_NAME = "ozy-ssh-keygen";
export const SSH_KEYGEN_CMD_PATH = commandPath(SSH_KEYGEN_CMD_NAME);
export const VIRTUAL_KEY_LOG_FILE_PATH = besideTool(`${VIRTUAL_KEY_CMD_NAME}.log`);
export const DEFAULT_SESSION_TIMEOUT_SECONDS = 120;
export const STANDARD_REMOTE_USER = "git";
export const STANDARD_REMOTE_HOST = "github.com";
export const STANDARD_REMOTE_PREFIX = `${STANDARD_REMOTE_USER}@${STANDARD_REMOTE_HOST}:`;
