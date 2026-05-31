import { AGENT_SOCK_FILE_PATH } from "@/common/constants";

const result = Bun.spawnSync(["ssh-keygen", ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, SSH_AUTH_SOCK: AGENT_SOCK_FILE_PATH },
});

process.exit(result.exitCode ?? 1);
