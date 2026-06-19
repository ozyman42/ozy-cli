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
  const allCmds = entrypoints.map(f => basename(f, SUFFIX));
  for (const entrypoint of entrypoints) {
    const cmd = basename(entrypoint, SUFFIX);
    const outFile = join(OUTDIR, cmd);
    writeFileSync(outFile, generateLauncher(cmd, allCmds), { mode: 0o755 });
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
          Option.getOrElse(() => ({}))
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

function generateLauncher(cmd: string, allCmds: string[]): string {
  const pkgName: string = PKG.name;
  const pkgVersion: string = PKG.version;
  return `#!/usr/bin/env node
import { spawnSync } from 'child_process';
import { writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const SELF = process.argv[1];
const INSTALL_DIR = dirname(SELF);
const CMD = '${cmd}';
const ALL_CMDS = ${JSON.stringify(allCmds.sort())};
const PKG_NAME = '${pkgName}';
const PKG_VERSION = '${pkgVersion}';

function log(msg) { process.stderr.write(\`\${msg}\\n\`); }

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
  log(\`unsupported platform: "\${rawKey}"\`);
  process.exit(1);
}

const pkgBaseName = PKG_NAME.split('/').pop();
const platformVersion = \`\${PKG_VERSION}-\${platformKey}.0\`;
const tarballUrl = \`https://registry.npmjs.org/\${PKG_NAME}/-/\${pkgBaseName}-\${platformVersion}.tgz\`;
const isWindows = platformKey.startsWith('windows-');

log(\`Fetching all \${platformKey} platform binaries (\${ALL_CMDS.join(", ")})\\nfrom \${tarballUrl}\`);

try {
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    log(\`fetch failed: \${response.status} \${response.statusText}\`);
    process.exit(1);
  }
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  const reader = response.body.getReader();
  const chunks = [];
  let downloaded = 0;
  const totalMb = (contentLength / 1024 / 1024).toFixed(1);
  function clearLine() {
    process.stderr.write(\`\\r                                        \`);
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    const mb = (downloaded / 1024 / 1024).toFixed(1);
    if (contentLength) {
      const pct = Math.round(downloaded / contentLength * 100);
      clearLine();
      process.stderr.write(\`\\rdownloading... \${pct.toString().padStart(3, " ")}% (\${mb}MB/\${totalMb}MB)\`);
    } else {
      clearLine();
      process.stderr.write(\`\\rdownloading... \${mb}MB\`);
    }
  }
  clearLine();
  process.stderr.write(\`\\rdownloading... 100% (\${totalMb}MB)\`);
  process.stderr.write('\\n');
  const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));

  const tempDir = mkdtempSync(join(tmpdir(), \`\${pkgBaseName}-install-\`));
  try {
    const extractResult = spawnSync('tar', ['-xzf', '-', '-C', tempDir], {
      input: buffer,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (extractResult.status !== 0) {
      log(\`tar extraction failed (status \${extractResult.status})\`);
      process.exit(1);
    }
    for (const c of ALL_CMDS) {
      const src = join(tempDir, 'package', 'dist', c + (isWindows ? '.exe' : ''));
      const dest = join(INSTALL_DIR, c + (isWindows ? '.exe' : ''));
      const content = readFileSync(src);
      writeFileSync(dest, content);
      chmodSync(dest, 0o755);
    }
  } finally {
    rmSync(tempDir, { recursive: true });
  }
  process.stderr.write(\`Installed \${ALL_CMDS.join(', ')}\\n\`);
  const result = spawnSync(SELF, process.argv.slice(2), { stdio: 'inherit' });
  const errStr = result.error ? \`  error=\${result.error.message}\` : '';
  process.exit(result.status !== null ? result.status : 1);
} catch (err) {
  log(\`error: \${err.message}\`);
  process.exit(1);
}
`;
}
