import { rmSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Option, Schema, pipe } from "effect";

const PlatformSchema = Schema.Literals(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "base-package"] as const);
type Platform = Schema.Schema.Type<typeof PlatformSchema>;

const platform: Option.Option<Platform> = pipe(
  Option.fromNullishOr(process.argv[2]),
  Option.map(Schema.decodeUnknownSync(PlatformSchema))
);

const SUFFIX = ".ts";
const OUTDIR = "dist";
const PKG = JSON.parse(readFileSync("package.json", "utf-8"));

rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR);

const entrypoints = readdirSync("src/entrypoints")
  .filter(f => f.endsWith(SUFFIX))
  .map(f => `src/entrypoints/${f}`);

if (Option.isSome(platform) && platform.value === "base-package") {
  for (const entrypoint of entrypoints) {
    const cmd = basename(entrypoint, SUFFIX);
    const outFile = join(OUTDIR, cmd);
    writeFileSync(outFile, generateLauncher(cmd), { mode: 0o755 });
    console.log(`${entrypoint} -> ${outFile} (node downloader)`);
  }
} else {
  for (const entrypoint of entrypoints) {
    const cmd = basename(entrypoint, SUFFIX);
    const outFile = join(OUTDIR, cmd);

    const result = await Bun.build({
      entrypoints: [entrypoint],
      compile: {
        outfile: outFile,
        ...(pipe(
          platform,
          Option.map(v => ({ target: `bun-${v}` as Bun.Build.CompileTarget })),
          Option.orElse(() => ({} as any))
        ))
      },
      sourcemap: "inline",
    });

    if (!result.success) {
      for (const log of result.logs) console.error(log);
      process.exit(1);
    }
    console.log(`${entrypoint} -> ${outFile}`);
  }

  if (Option.isSome(platform)) {
    PKG.version = `${PKG.version}-${platform.value}.0`;
    writeFileSync("package.json", JSON.stringify(PKG, null, 2) + "\n");
    console.log(`Updated package.json version to ${PKG.version}`);
  }
}

function generateLauncher(cmd: string): string {
  const pkgName: string = PKG.name;
  const pkgVersion: string = PKG.version;
  return `#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { writeFileSync, chmodSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const CMD = '${cmd}';
const PKG_NAME = '${pkgName}';
const PKG_VERSION = '${pkgVersion}';

// process.platform: 'aix'|'android'|'darwin'|'freebsd'|'haiku'|'linux'|'openbsd'|'sunos'|'win32'
// process.arch:     'arm'|'arm64'|'ia32'|'loong64'|'mips'|'mipsel'|'ppc64'|'riscv64'|'s390'|'s390x'|'x64'
const PLATFORM_MAP = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64':   'darwin-x64',
  'linux-arm64':  'linux-arm64',
  'linux-x64':    'linux-x64',
  'win32-x64':    'windows-x64',
};

const rawKey = \`\${process.platform}-\${process.arch}\`;
const platformKey = PLATFORM_MAP[rawKey];
if (!platformKey) {
  process.stderr.write(\`Unsupported platform: \${process.platform}-\${process.arch}\\n\`);
  process.exit(1);
}

const pkgBaseName = PKG_NAME.split('/').pop();
const platformVersion = \`\${PKG_VERSION}-\${platformKey}.0\`;
const tarballUrl = \`https://registry.npmjs.org/\${PKG_NAME}/-/\${pkgBaseName}-\${platformVersion}.tgz\`;
const isWindows = platformKey.startsWith('windows-');
const binInTarball = \`package/dist/\${CMD}\${isWindows ? '.exe' : ''}\`;

process.stderr.write(\`Downloading \${CMD} for \${platformKey}...\\n\`);

try {
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    process.stderr.write(\`Failed to download: \${response.status} \${response.statusText}\\n\`);
    process.exit(1);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const extracted = spawnSync('tar', ['-xzOf', '-', binInTarball], {
    input: buffer,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  if (extracted.status !== 0) {
    process.stderr.write(\`Failed to extract \${binInTarball} from tarball\\n\`);
    process.exit(1);
  }

  writeFileSync(__filename, extracted.stdout);
  chmodSync(__filename, 0o755);
  process.stderr.write(\`Installed \${CMD}\\n\`);

  const result = spawnSync(__filename, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} catch (err) {
  process.stderr.write(\`Error: \${err.message}\\n\`);
  process.exit(1);
}
`;
}
