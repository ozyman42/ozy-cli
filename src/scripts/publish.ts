import * as path from "path";
import * as fs from "fs/promises";

// only publish on workflow dispatch on push to default branch (config can change this later)
const event = process.argv[2];
if (event !== "push") {
  console.log("Skipping publish. Only publishing to NPM on push events. Current event is", event);
  process.exit(0);
}

const buildFolderName = "dist";
const expectedFileType = ".tgz";
const distFolder = path.resolve(__dirname, `../../${buildFolderName}`);
const children = await fs.readdir(distFolder);
const badChildren = new Set<string>();
for (const child of children) {
  if (!child.endsWith(expectedFileType)) {
    badChildren.add(child);
  }
}
if (badChildren.size > 0) {
  console.log(`Only expected ${expectedFileType} files in ${buildFolderName} folder. Instead got following:`);
  for (const child of children) {
    const isBad = badChildren.has(child);
    const prefix = isBad ? "::error::" : "";
    const suffix = isBad ? "" : "";
    console.log(`${prefix}- ${child}${suffix}`);
  }
  process.exit(1);
}
for (const child of children) {
  const fullPath = path.resolve(distFolder, child).toLocaleLowerCase();
  const tarball = `./${buildFolderName}/${child}`;
  const tag = path.basename(fullPath, expectedFileType);
  // 11.5.1 is when OIDC / trusted publishing were added
  const command = ["bunx", "npm@^11.5.1", "publish", tarball, "--tag", tag, "--loglevel", "silly"];
  console.log(command.join(" "));
  const exitCode = await Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env
  }).exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
