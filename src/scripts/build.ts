import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const outPath = "dist/index.js";
const content = await Bun.file(outPath).text();
await Bun.write(outPath, `#!/usr/bin/env bun\n${content}`);
Bun.spawnSync(["chmod", "+x", outPath]);

console.log("Built dist/index.js");
