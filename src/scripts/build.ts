import { rmSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

rmSync("dist", { recursive: true, force: true });

const SUFFIX = ".ts";
const OUTDIR = "dist";

const entrypoints = readdirSync("src/entrypoints")
  .filter(f => f.endsWith(SUFFIX))
  .map(f => `src/entrypoints/${f}`);

const longestEntry = Math.max(...entrypoints.map(entry => entry.length));

for (const entrypoint of entrypoints) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: OUTDIR,
    compile: true
  });
  const inFile = entrypoint;
  const baseName = basename(inFile);
  const outFile = join(OUTDIR, baseName.slice(0, baseName.length - SUFFIX.length));

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`${inFile.padStart(longestEntry, " ")} -> ${outFile}`);
}
