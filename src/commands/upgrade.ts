import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Option } from "effect";
import { makeCommand } from "../common/command";

type PackageManager = "bun" | "pnpm" | "npm";
type InstallScope = "global" | "local";

interface InstallInfo {
  pm: PackageManager;
  scope: InstallScope;
  cwd?: string;
}

function findLockFile(dir: string): Option.Option<PackageManager> {
  let current = dir;
  while (true) {
    if (existsSync(join(current, "bun.lock")) || existsSync(join(current, "bun.lockb"))) return Option.some("bun" as PackageManager);
    if (existsSync(join(current, "pnpm-lock.yaml"))) return Option.some("pnpm" as PackageManager);
    if (existsSync(join(current, "package-lock.json"))) return Option.some("npm" as PackageManager);
    const parent = dirname(current);
    if (parent === current) return Option.none();
    current = parent;
  }
}

function detectInstall(binaryPath: string): Option.Option<InstallInfo> {
  if (binaryPath.includes("/.bun/bin/")) {
    return Option.some({ pm: "bun", scope: "global" } as InstallInfo);
  }
  if (binaryPath.includes("/pnpm/")) {
    return Option.some({ pm: "pnpm", scope: "global" } as InstallInfo);
  }
  const localMatch = binaryPath.match(/^(.+\/node_modules)\/.bin\//);
  if (localMatch) {
    const projectRoot = dirname(localMatch[1]!);
    const pm = Option.getOrElse(findLockFile(projectRoot), () => "npm" as PackageManager);
    return Option.some({ pm, scope: "local", cwd: projectRoot } as InstallInfo);
  }
  return Option.none();
}

function buildUpgradeCommand(info: InstallInfo): string[] {
  const pkg = "@ozyman42/ozy-cli@latest";
  if (info.scope === "global") {
    if (info.pm === "bun") return ["bun", "add", "--no-cache", "-g", pkg];
    if (info.pm === "pnpm") return ["pnpm", "add", "-g", pkg];
    return ["npm", "install", "-g", pkg];
  }
  if (info.pm === "bun") return ["bun", "add", "--no-cache", pkg];
  if (info.pm === "pnpm") return ["pnpm", "add", pkg];
  return ["npm", "install", pkg];
}

function whichOzy(): Effect.Effect<string, string> {
  return Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["which", "ozy"], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) throw new Error("ozy binary not found — install with: bun add -g @ozyman42/ozy-cli");
      return (await new Response(proc.stdout).text()).trim();
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

export const upgrade = makeCommand("upgrade", "upgrade ozy-cli to the latest version", () =>
  Effect.gen(function* () {
    const binaryPath = yield* whichOzy();

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
