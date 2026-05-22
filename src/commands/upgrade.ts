import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeCommand } from "../common/command";
import { Ok, Err } from "../common/result";

type PackageManager = "bun" | "pnpm" | "npm";
type InstallScope = "global" | "local";

interface InstallInfo {
  pm: PackageManager;
  scope: InstallScope;
  cwd?: string;
}

function findLockFile(dir: string): PackageManager | undefined {
  let current = dir;
  while (true) {
    if (existsSync(join(current, "bun.lock")) || existsSync(join(current, "bun.lockb"))) return "bun";
    if (existsSync(join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(current, "package-lock.json"))) return "npm";
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function detectInstall(binaryPath: string): InstallInfo | undefined {
  if (binaryPath.includes("/.bun/bin/")) {
    return { pm: "bun", scope: "global" };
  }
  if (binaryPath.includes("/pnpm/")) {
    return { pm: "pnpm", scope: "global" };
  }
  const localMatch = binaryPath.match(/^(.+\/node_modules)\/.bin\//);
  if (localMatch) {
    const projectRoot = dirname(localMatch[1]);
    const pm = findLockFile(projectRoot) ?? "npm";
    return { pm, scope: "local", cwd: projectRoot };
  }
  return undefined;
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

async function whichOzy(): Promise<string | undefined> {
  const proc = Bun.spawn(["which", "ozy"], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) return undefined;
  return (await new Response(proc.stdout).text()).trim();
}

export const upgrade = makeCommand("upgrade", "upgrade ozy-cli to the latest version", async () => {
  const binaryPath = await whichOzy();
  if (!binaryPath) {
    return Err("not-installed", "ozy binary not found — install with: bun add -g @ozyman42/ozy-cli");
  }

  const info = detectInstall(binaryPath);
  if (!info) {
    return Err(
      "unknown-install",
      `could not detect package manager from binary path: ${binaryPath}\nUpgrade manually with your package manager.`
    );
  }

  const cmd = buildUpgradeCommand(info);
  console.log(`Detected: ${info.pm} (${info.scope})`);
  console.log(`Running: ${cmd.join(" ")}`);

  const proc = Bun.spawn(cmd, {
    cwd: info.cwd ?? process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    return Err("install-failed", `${cmd[0]} exited with code ${code}`);
  }

  return Ok(true);
});
