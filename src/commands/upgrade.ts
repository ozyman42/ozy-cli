import { upgrade as upgradePackage } from "jive-abstract-library";
import { makeCommand } from "@/common/command";
import { CLI_CMD_NAME, CLI_CMD_PATH, PACKAGE_NAME } from "@/common/constants";

/**
 * Detecting how ozy was installed and re-running that install lives in `jive-abstract-library`, shared
 * with every package built from it. It also re-runs the new version's install script where bun or pnpm
 * skip it, which keeps `ozy-signing-agent`'s registration pointing at a working binary.
 */
export const upgrade = makeCommand("upgrade", `upgrade ${CLI_CMD_NAME} to the latest version`, function* () {
  yield* upgradePackage({ packageName: PACKAGE_NAME, commandPath: CLI_CMD_PATH });
});
