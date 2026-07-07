import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Effect, Option } from "effect";
import { makeCommand } from "@/common/command";
import { CLI_CMD_NAME, CLI_CMD_PATH, PACKAGE_NAME } from "@/common/constants";

type PackageManager = "bun" | "pnpm" | "npm" | "yarn";
type InstallScope = "global" | "local";

interface InstallInfo {
  pm: PackageManager;
  scope: InstallScope;
  cwd?: string;
}

const PACKAGE_NODE_MODULES_SEGMENT = `/node_modules/${PACKAGE_NAME}/`;
const LOCAL_BIN_SEGMENT = "/node_modules/.bin/";

/*
 * Directory shapes this detector understands.
 *
 * Local installs:
 *   project/
 *     node_modules/
 *       .bin/
 *         ozy -> ../@ozyman42/ozy-cli/bin/ozy       # POSIX link or shell shim
 *         ozy.cmd / ozy.ps1 / ozy.exe              # Windows manager-specific shim
 *       @ozyman42/
 *         ozy-cli/
 *           bin/
 *             ozy                                  # CLI_CMD_PATH after repair
 *
 * Bun global:
 *   ~/.bun/bin/ozy -> ~/.bun/install/global/node_modules/@ozyman42/ozy-cli/bin/ozy
 *
 * pnpm global:
 *   ~/Library/pnpm/ozy -> ~/.local/share/pnpm/global/<slot>/node_modules/@ozyman42/ozy-cli/bin/ozy
 *   ~/.pnpm-global/.../node_modules/@ozyman42/ozy-cli/bin/ozy
 *
 * npm global:
 *   ~/.nvm/versions/node/vX.Y.Z/bin/ozy -> ~/.nvm/versions/node/vX.Y.Z/lib/node_modules/@ozyman42/ozy-cli/bin/ozy
 *   /usr/local/bin/ozy -> /usr/local/lib/node_modules/@ozyman42/ozy-cli/bin/ozy
 *   %APPDATA%/npm/ozy.cmd -> %APPDATA%/npm/node_modules/@ozyman42/ozy-cli/bin/ozy
 *
 * Yarn Classic global:
 *   ~/.yarn/bin/ozy -> ~/.config/yarn/global/node_modules/@ozyman42/ozy-cli/bin/ozy
 *   %LOCALAPPDATA%/Yarn/bin/ozy.cmd -> %LOCALAPPDATA%/Yarn/Data/global/node_modules/@ozyman42/ozy-cli/bin/ozy
 */

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function parentDirectory(dir: string): string {
  return normalizePath(path.dirname(dir));
}

function hasProjectMarkers(dir: string): boolean {
  return (
    existsSync(path.join(dir, "package.json")) ||
    existsSync(path.join(dir, "bun.lock")) ||
    existsSync(path.join(dir, "bun.lockb")) ||
    existsSync(path.join(dir, "pnpm-lock.yaml")) ||
    existsSync(path.join(dir, "yarn.lock")) ||
    existsSync(path.join(dir, "package-lock.json"))
  );
}

function packageManagerName(value: unknown): Option.Option<PackageManager> {
  if (typeof value !== "string") return Option.none();
  if (value.startsWith("bun@") || value === "bun") return Option.some("bun");
  if (value.startsWith("pnpm@") || value === "pnpm") return Option.some("pnpm");
  if (value.startsWith("yarn@") || value === "yarn") return Option.some("yarn");
  if (value.startsWith("npm@") || value === "npm") return Option.some("npm");
  return Option.none();
}

function packageManagerFromPackageJson(dir: string): Option.Option<PackageManager> {
  const packageJsonPath = path.join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return Option.none();
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const packageManager = packageManagerName(packageJson.packageManager);
    if (Option.isSome(packageManager)) return packageManager;

    const devEnginePackageManager = packageJson.devEngines?.packageManager;
    if (Array.isArray(devEnginePackageManager)) {
      for (const entry of devEnginePackageManager) {
        const pm = packageManagerName(entry?.name);
        if (Option.isSome(pm)) return pm;
      }
    }

    return packageManagerName(devEnginePackageManager?.name);
  } catch {
    return Option.none();
  }
}

function findProjectPackageManager(dir: string): Option.Option<PackageManager> {
  let current = dir;
  while (true) {
    const packageManager = packageManagerFromPackageJson(current);
    if (Option.isSome(packageManager)) return packageManager;
    if (existsSync(path.join(current, "bun.lock")) || existsSync(path.join(current, "bun.lockb"))) return Option.some("bun");
    if (existsSync(path.join(current, "pnpm-lock.yaml"))) return Option.some("pnpm");
    if (existsSync(path.join(current, "yarn.lock"))) return Option.some("yarn");
    if (existsSync(path.join(current, "package-lock.json"))) return Option.some("npm");
    const parent = parentDirectory(current);
    if (parent === current) return Option.none();
    current = parent;
  }
}

function detectGlobalInstall(normalizedPath: string): Option.Option<InstallInfo> {
  const lowerPath = normalizedPath.toLowerCase();

  if (lowerPath.includes("/.bun/bin/") || lowerPath.includes("/.bun/install/global/node_modules/"))
    return Option.some({ pm: "bun", scope: "global" });

  if (
    lowerPath.includes("/.pnpm-global/") ||
    lowerPath.includes("/pnpm/global/") ||
    lowerPath.includes("/library/pnpm/") ||
    lowerPath.includes("/appdata/local/pnpm/")
  )
    return Option.some({ pm: "pnpm", scope: "global" });

  if (
    lowerPath.includes("/.yarn/bin/") ||
    lowerPath.includes("/appdata/local/yarn/bin/") ||
    lowerPath.includes("/.config/yarn/global/node_modules/") ||
    (lowerPath.includes("/appdata/local/yarn/") && lowerPath.includes("/global/node_modules/"))
  )
    return Option.some({ pm: "yarn", scope: "global" });

  if (
    lowerPath.includes("/.nvm/versions/node/") ||
    lowerPath.includes("/.nodenv/versions/") ||
    // asdf is a multi-runtime version manager; default data lives under ~/.asdf.
    // https://asdf-vm.com/guide/getting-started.html
    lowerPath.includes("/.asdf/installs/nodejs/") ||
    lowerPath.includes("/appdata/roaming/npm/") ||
    lowerPath.includes("/program files/nodejs/node_modules/") ||
    lowerPath.startsWith("/usr/local/bin/") ||
    lowerPath.startsWith("/opt/homebrew/bin/") ||
    lowerPath.startsWith("/usr/local/lib/node_modules/") ||
    lowerPath.startsWith("/opt/homebrew/lib/node_modules/") ||
    lowerPath.startsWith("/usr/lib/node_modules/")
  )
    return Option.some({ pm: "npm", scope: "global" });

  return Option.none();
}

function localInstallInfo(projectRoot: string): Option.Option<InstallInfo> {
  if (!hasProjectMarkers(projectRoot)) return Option.none();
  const pm = Option.getOrElse(findProjectPackageManager(projectRoot), () => "npm" as PackageManager);
  return Option.some({ pm, scope: "local", cwd: projectRoot });
}

function detectLocalInstall(normalizedPath: string): Option.Option<InstallInfo> {
  const lowerPath = normalizedPath.toLowerCase();

  const localBinIndex = lowerPath.indexOf(LOCAL_BIN_SEGMENT);
  if (localBinIndex >= 0) {
    return localInstallInfo(normalizedPath.slice(0, localBinIndex));
  }

  const packageIndex = lowerPath.indexOf(PACKAGE_NODE_MODULES_SEGMENT);
  if (packageIndex >= 0) {
    return localInstallInfo(normalizedPath.slice(0, packageIndex));
  }

  return Option.none();
}

function detectInstall(binaryPath: string): Option.Option<InstallInfo> {
  const normalizedPath = normalizePath(binaryPath);
  const globalInstall = detectGlobalInstall(normalizedPath);
  if (Option.isSome(globalInstall)) return globalInstall;
  return detectLocalInstall(normalizedPath);
}

function buildUpgradeCommand(info: InstallInfo): string[] {
  const pkg = `${PACKAGE_NAME}@latest`;
  if (info.scope === "global") {
    if (info.pm === "bun") return ["bun", "add", "--no-cache", "-g", pkg];
    if (info.pm === "pnpm") return ["pnpm", "add", "-g", pkg];
    if (info.pm === "yarn") return ["yarn", "global", "add", pkg];
    return ["npm", "install", "-g", pkg];
  }
  if (info.pm === "bun") return ["bun", "add", "--no-cache", pkg];
  if (info.pm === "pnpm") return ["pnpm", "add", pkg];
  if (info.pm === "yarn") return ["yarn", "add", pkg];
  return ["npm", "install", pkg];
}

export const upgrade = makeCommand("upgrade", `upgrade ${CLI_CMD_NAME} to the latest version`, () =>
  Effect.gen(function* () {
    const binaryPath = CLI_CMD_PATH;
    const infoOption = detectInstall(binaryPath);
    if (Option.isNone(infoOption))
      return yield* Effect.fail(`unknown-install: could not detect package manager from binary path: ${binaryPath}\nUpgrade manually with your package manager.`);
    const info = infoOption.value;

    const cmd = buildUpgradeCommand(info);
    console.log(`Detected: ${info.pm} (${info.scope})`);
    console.log(`Running: ${cmd.join(" ")}`);

    const proc = Bun.spawn(cmd, {
      cwd: info.cwd ?? process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = yield* Effect.promise(() => proc.exited);
    if (code !== 0)
      yield* Effect.fail(`install-failed: ${cmd[0]} exited with code ${code}`);
  })
);
