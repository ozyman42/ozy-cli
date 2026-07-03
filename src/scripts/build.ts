import {
  access,
  chmod,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { Schema } from "effect";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

/**
 * Jive library builder.
 *
 * Source package:
 *   src/index.ts        Optional package TypeScript ESM entrypoint.
 *   src/entrypoints/*   Command entrypoints included in the generated multi-call binary.
 *   src/agents/*        Agent entrypoints, if present, included in the same multi-call binary.
 *
 * Generated base package:
 *   package.json        Stripped package manifest plus generated runtime install hook.
 *   src/                Source tree for package consumers.
 *   dist/               TypeScript-emitted library files, when a source entrypoint exists.
 *   multi-call.js       Generated JS launcher used by every bin before first install/run.
 *
 * Generated platform packages:
 *   package.json        Same package name with platform-specific prerelease version and os/cpu.
 *   multi-call-binary   Native Bun-compiled multi-call executable.
 *
 * The dist folder contains only packed .tgz files. The file name is the npm dist-tag to publish:
 * latest.tgz for the base package and one <platform>.tgz per platform package.
 * 
 * Files in the following directories will be non importable from dependents
 *   src/entrypoints/*
 *   src/agents/*
 *   src/internal
 * So for example `import * as a from "my-package/internal"` will fail to compile
 */

const COMMAND_SOURCE_DIRS = ["src/entrypoints", "src/agents"] as const;
const PRIVATE_SOURCE_DIRS = [...COMMAND_SOURCE_DIRS, "src/internal"] as const;
const SOURCE_ENTRYPOINT = "src/index.ts";
const SOURCE_SUFFIX = ".ts";
const OUTDIR = "dist";
const WORKDIR = "build-temp";
const MULTI_CALL_JS = "multi-call.js";
const MULTI_CALL_BINARY = "multi-call-binary";
const TSCONFIG_INCLUDE = ["src/**/*.ts"];
const TSCONFIG_EXCLUDE = [OUTDIR, "node_modules"];
const JSONC_FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
  insertFinalNewline: true,
} as const satisfies FormattingOptions;

type Platform = {
  readonly id: string;
  readonly target: Bun.Build.CompileTarget;
  readonly os: string;
  readonly cpu: string;
};

const PLATFORMS = [
  { id: "darwin-arm64", target: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "darwin-x64", target: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { id: "linux-arm64", target: "bun-linux-arm64", os: "linux", cpu: "arm64" },
  { id: "linux-x64", target: "bun-linux-x64", os: "linux", cpu: "x64" },
  { id: "windows-x64", target: "bun-windows-x64", os: "win32", cpu: "x64" },
] as const satisfies readonly Platform[];

const PackageJson = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  description: Schema.optional(Schema.String),
  type: Schema.optional(Schema.Literal("module")),
  license: Schema.optional(Schema.String),
  author: Schema.optional(Schema.Unknown),
  contributors: Schema.optional(Schema.Unknown),
  keywords: Schema.optional(Schema.Unknown),
  homepage: Schema.optional(Schema.String),
  bugs: Schema.optional(Schema.Unknown),
  funding: Schema.optional(Schema.Unknown),
  repository: Schema.optional(Schema.Unknown),
  publishConfig: Schema.optional(Schema.Unknown),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type PackageJson = Schema.Schema.Type<typeof PackageJson>;

type CommandSource = {
  readonly command: string;
  readonly sourcePath: string;
};

class TscFailed extends Error {
  constructor(readonly exitCode: number) {
    super(`tsc failed with exit code ${exitCode}`);
  }
}

const rootDir = process.cwd();
const outDir = resolve(rootDir, OUTDIR);
const workDir = resolve(outDir, WORKDIR);
const multiCallEntrypointPath = resolve(workDir, "multi-call.ts");
const packageJson = await readPackageJson();
const commandSources = await collectCommandSources();
const sourceEntrypoint = resolve(rootDir, SOURCE_ENTRYPOINT);
const hasSourceEntrypoint = await pathExists(sourceEntrypoint);
const hasCommandSources = commandSources.length > 0;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(workDir, { recursive: true });

try {
  if (hasCommandSources) {
    await writeFile(multiCallEntrypointPath, generateMultiCallEntrypoint(multiCallEntrypointPath));
  }

  await buildBasePackage();

  if (hasCommandSources) {
    await Promise.all(PLATFORMS.map(buildPlatformPackage));
  }
} catch (error) {
  if (error instanceof TscFailed) {
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}

async function readPackageJson(): Promise<PackageJson> {
  const parsed = JSON.parse(await readFile(resolve(rootDir, "package.json"), "utf-8"));
  return Schema.decodeUnknownSync(PackageJson)(parsed);
}

async function collectCommandSources(): Promise<readonly CommandSource[]> {
  const commands = new Map<string, CommandSource>();

  for (const sourceDir of COMMAND_SOURCE_DIRS) {
    const absoluteSourceDir = resolve(rootDir, sourceDir);
    if (!(await pathExists(absoluteSourceDir))) continue;

    for (const child of (await readdir(absoluteSourceDir)).sort()) {
      if (!child.endsWith(SOURCE_SUFFIX)) continue;

      const command = basename(child, SOURCE_SUFFIX);
      const sourcePath = resolve(absoluteSourceDir, child);
      const existing = commands.get(command);
      if (existing) {
        throw new Error(`Duplicate command "${command}" in ${existing.sourcePath} and ${sourcePath}`);
      }
      commands.set(command, { command, sourcePath });
    }
  }

  return [...commands.values()].sort((a, b) => a.command.localeCompare(b.command));
}

async function buildBasePackage(): Promise<void> {
  const packageDir = resolve(workDir, "base-package");
  await mkdir(packageDir, { recursive: true });

  if (hasSourceEntrypoint) {
    await transpileLibrarySource(packageDir);
  }

  await cp(resolve(rootDir, "src"), resolve(packageDir, "src"), { recursive: true });
  if (hasCommandSources) {
    await writeFile(resolve(packageDir, MULTI_CALL_JS), generateLauncher(), { mode: 0o755 });
  }

  await writePackageJson(packageDir, generateBasePackageJson());
  await packPackage(packageDir, "latest");
}

async function buildPlatformPackage(platform: Platform): Promise<void> {
  const packageDir = resolve(workDir, platform.id);
  await mkdir(packageDir, { recursive: true });

  const binaryPath = resolve(packageDir, MULTI_CALL_BINARY);
  const buildResult = await Bun.build({
    entrypoints: [multiCallEntrypointPath],
    compile: {
      outfile: binaryPath,
      target: platform.target,
    },
    sourcemap: "inline",
  });
  assertBuildSucceeded(buildResult, `compile ${platform.id} multi-call binary`);

  const windowsBinaryPath = `${binaryPath}.exe`;
  if (!(await pathExists(binaryPath)) && (await pathExists(windowsBinaryPath))) {
    await rename(windowsBinaryPath, binaryPath);
  }
  await chmod(binaryPath, 0o755);

  await writePackageJson(packageDir, generatePlatformPackageJson(platform));
  await packPackage(packageDir, platform.id);
}

function assertBuildSucceeded(result: Bun.BuildOutput, label: string): void {
  if (result.success) return;

  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error(`Failed to ${label}`);
}

async function writePackageJson(packageDir: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(resolve(packageDir, "package.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function transpileLibrarySource(packageDir: string): Promise<void> {
  const rootTsconfigPath = resolve(rootDir, "tsconfig.json");
  await ensureTsconfigSourceBoundary(rootTsconfigPath);

  const tscPath = resolve(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

  // TODO: tool should just come bundled with typescript.
  if (!(await pathExists(tscPath))) {
    throw new Error("TypeScript is required to emit library source. Install typescript as a devDependency.");
  }

  const exitCode = await Bun.spawn(
    [
      tscPath,
      "--project",
      rootTsconfigPath,
      "--rootDir",
      resolve(rootDir, "src"),
      "--outDir",
      resolve(packageDir, "dist"),
      "--pretty",
      "true",
      "--noEmit",
      "false",
      "--declaration",
      "false",
      "--declarationMap",
      "false",
      "--sourceMap",
      "--rewriteRelativeImportExtensions",
    ],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  ).exited;
  if (exitCode !== 0) {
    throw new TscFailed(exitCode);
  }
}

async function ensureTsconfigSourceBoundary(tsconfigPath: string): Promise<void> {
  const originalText = await readFile(tsconfigPath, "utf-8");
  assertValidJsonc(tsconfigPath, originalText);

  const withInclude = applyEdits(
    originalText,
    modify(originalText, ["include"], TSCONFIG_INCLUDE, {
      formattingOptions: JSONC_FORMATTING_OPTIONS,
      getInsertionIndex: (properties) => insertAfter(properties, "compilerOptions"),
    })
  );
  const withExclude = applyEdits(
    withInclude,
    modify(withInclude, ["exclude"], TSCONFIG_EXCLUDE, {
      formattingOptions: JSONC_FORMATTING_OPTIONS,
      getInsertionIndex: (properties) => insertAfter(properties, "include"),
    })
  );

  assertValidJsonc(tsconfigPath, withExclude);
  if (withExclude !== originalText) {
    await writeFile(tsconfigPath, withExclude);
  }
}

function assertValidJsonc(filePath: string, text: string): void {
  const errors: ParseError[] = [];
  parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length === 0) return;

  const details = errors
    .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
    .join(", ");
  throw new Error(`${filePath} is invalid JSONC: ${details}`);
}

function insertAfter(properties: readonly string[], property: string): number {
  const index = properties.indexOf(property);
  return index === -1 ? properties.length : index + 1;
}

function generateBasePackageJson(): Record<string, unknown> {
  const generated: Record<string, unknown> = {};
  for (const key of [
    "name",
    "version",
    "description",
    "type",
    "license",
    "author",
    "contributors",
    "keywords",
    "homepage",
    "bugs",
    "funding",
    "repository",
    "publishConfig",
  ] as const) {
    const value = packageJson[key];
    if (value !== undefined) generated[key] = value;
  }

  generated["type"] = packageJson["type"] ?? "module";
  if (hasSourceEntrypoint) {
    generated["main"] = "./dist/index.js";
    generated["module"] = "./dist/index.js";
    generated["types"] = "./src/index.ts";
    generated["exports"] = {
      ".": {
        types: "./src/index.ts",
        import: "./dist/index.js",
      },
      ...Object.fromEntries(
        PRIVATE_SOURCE_DIRS.flatMap((sourceDir) => {
          const subpath = sourceDir.replace(/^src\//, "");
          return [
            [`./${subpath}`, null],
            [`./${subpath}/*`, null],
          ];
        })
      ),
      "./*": {
        types: "./src/*.ts",
        import: "./dist/*.js",
      },
    };
  }
  const files = hasSourceEntrypoint ? ["dist", "src"] : [];
  if (hasCommandSources) files.push(MULTI_CALL_JS);
  if (files.length > 0) generated["files"] = files;
  if (hasCommandSources) {
    generated["bin"] = Object.fromEntries(commandSources.map(({ command }) => [command, `./${MULTI_CALL_JS}`]));
    generated["scripts"] = {
      postinstall: `node ./${MULTI_CALL_JS}`,
    };
  }
  if (packageJson["dependencies"]) generated["dependencies"] = packageJson["dependencies"];
  if (hasCommandSources) {
    generated["optionalDependencies"] = Object.fromEntries(
      PLATFORMS.map((platform) => [
        platformAliasName(platform),
        `npm:${packageJson.name}@${platformVersion(platform)}`,
      ])
    );
  }

  return generated;
}

function generatePlatformPackageJson(platform: Platform): Record<string, unknown> {
  const generated: Record<string, unknown> = {
    name: packageJson.name,
    version: platformVersion(platform),
    type: packageJson.type ?? "module",
    os: [platform.os],
    cpu: [platform.cpu],
    files: [MULTI_CALL_BINARY],
  };

  for (const key of ["description", "license", "repository", "publishConfig"] as const) {
    const value = packageJson[key];
    if (value !== undefined) generated[key] = value;
  }

  return generated;
}

function platformVersion(platform: Platform): string {
  return `${packageJson.version}-${platform.id}.0`;
}

function platformAliasName(platform: Platform): string {
  return `${packageJson.name}-${platform.id}`;
}

async function packPackage(packageDir: string, tag: string): Promise<void> {
  const npmCacheDir = resolve(workDir, "npm-cache");
  const output = await Bun.$`npm pack ${packageDir} --pack-destination ${outDir} --ignore-scripts --cache ${npmCacheDir} --loglevel error`.text();
  const generatedFile = output.trim().split("\n").at(-1);
  if (!generatedFile) throw new Error(`npm pack did not report an output file for ${packageDir}`);

  const sourcePath = resolve(outDir, generatedFile);
  const taggedPath = resolve(outDir, `${tag}.tgz`);
  await rm(taggedPath, { force: true });
  await rename(sourcePath, taggedPath);
  console.log(`${packageDir} -> ${relative(rootDir, taggedPath)}`);
}

function generateMultiCallEntrypoint(dispatcherPath: string): string {
  const dispatcherDir = dirname(dispatcherPath);
  const loaders = commandSources
    .map(({ command, sourcePath }) => {
      const importPath = toImportPath(relative(dispatcherDir, sourcePath));
      return `  ${JSON.stringify(command)}: () => import(${JSON.stringify(importPath)}),`;
    })
    .join("\n");

  return `import { basename } from "node:path";

const commandLoaders: Record<string, () => Promise<unknown>> = {
${loaders}
};

const invokedPath = process.argv0 || process.argv[1] || "";
const command = basename(invokedPath).replace(/\\.(?:exe|cmd|ps1)$/i, "");
const loadCommand = commandLoaders[command];

if (!loadCommand) {
  console.error(\`Unknown ${packageJson.name} command "\${command}". Expected one of: \${Object.keys(commandLoaders).sort().join(", ")}\`);
  process.exit(1);
}

await loadCommand();
`;
}

function generateLauncher(): string {
  const platformMap = Object.fromEntries(
    PLATFORMS.map((platform) => [`${platform.os}-${platform.cpu}`, platform.id])
  );
  const platformPackages = Object.fromEntries(
    PLATFORMS.map((platform) => [platform.id, platformAliasName(platform)])
  );

  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const PLATFORM_MAP = ${JSON.stringify(platformMap, null, 2)};
const PLATFORM_PACKAGES = ${JSON.stringify(platformPackages, null, 2)};
const COMMANDS = new Set(${JSON.stringify(commandSources.map(({ command }) => command), null, 2)});
const BINARY_FILE = ${JSON.stringify(MULTI_CALL_BINARY)};
const LAUNCHER_FILE = ${JSON.stringify(MULTI_CALL_JS)};
const targetPath = process.argv[1];
const invokedFile = targetPath ? basename(targetPath) : "";
const invokedCommand = invokedFile.replace(/\\.(?:exe|cmd|ps1)$/i, "");
const shouldRunCommand = invokedFile !== LAUNCHER_FILE && COMMANDS.has(invokedCommand);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function currentPlatformKey() {
  const platformKey = PLATFORM_MAP[\`\${process.platform}-\${process.arch}\`];
  if (!platformKey) {
    fail(\`Unsupported platform: \${process.platform}-\${process.arch}\`);
  }
  return platformKey;
}

function resolvePlatformBinary() {
  const platformKey = currentPlatformKey();
  const packageName = PLATFORM_PACKAGES[platformKey];
  if (!packageName) {
    fail(\`No platform package is configured for \${platformKey}\`);
  }

  try {
    const packageJsonPath = require.resolve(\`\${packageName}/package.json\`);
    return join(dirname(packageJsonPath), BINARY_FILE);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(\`Could not find optional dependency \${packageName}. Reinstall ${packageJson.name} with optional dependencies enabled.\\n\${detail}\`);
  }
}

function installPlatformBinary() {
  if (!targetPath) fail("Could not determine launcher path");

  const platformBinary = resolvePlatformBinary();
  copyFileSync(platformBinary, targetPath);
  chmodSync(targetPath, 0o755);
}

console.log(\`Copying multi-call-binary for \${process.platform}-\${process.arch}\`);

installPlatformBinary();

if (!shouldRunCommand) {
  process.exit(0);
}

const result = spawnSync(targetPath, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
`;
}

function toImportPath(path: string): string {
  const normalized = toPosixPath(path);
  if (normalized.startsWith(".") || normalized.startsWith("/")) return normalized;
  return `./${normalized}`;
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
