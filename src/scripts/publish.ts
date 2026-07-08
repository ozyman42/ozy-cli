import * as path from "path";
import * as fs from "fs/promises";
import { NPM_PACKAGE_SPEC, OUTDIR, PUBLISH_ORDER_FILE, TARBALL_EXTENSION } from "./constants";

// only publish on workflow dispatch on push to default branch (config can change this later)
const event = process.argv[2];
if (event !== "push") {
  console.log("Skipping publish. Only publishing to NPM on push events. Current event is", event);
  process.exit(0);
}

const buildFolderName = OUTDIR;
const expectedFileType = TARBALL_EXTENSION;
const publishOrderFileName = PUBLISH_ORDER_FILE;
const distFolder = path.resolve(__dirname, `../../${buildFolderName}`);
const children = await fs.readdir(distFolder);
const badChildren = new Set<string>();
for (const child of children) {
  if (!child.endsWith(expectedFileType) && child !== publishOrderFileName) {
    badChildren.add(child);
  }
}
if (badChildren.size > 0) {
  console.log(`Only expected ${expectedFileType} files or ${publishOrderFileName} in ${buildFolderName} folder. Instead got following:`);
  for (const child of children) {
    const isBad = badChildren.has(child);
    const prefix = isBad ? "::error::" : "";
    console.log(`${prefix}- ${child}`);
  }
  process.exit(1);
}
const tarballs = await orderedTarballs(children);
for (const child of tarballs) {
  const fullPath = path.resolve(distFolder, child).toLocaleLowerCase();
  const tarball = `./${buildFolderName}/${child}`;
  const tag = path.basename(fullPath, expectedFileType);
  const command = ["bunx", NPM_PACKAGE_SPEC, "publish", tarball, "--tag", tag, "--loglevel", "silly"];
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

async function orderedTarballs(children: string[]): Promise<string[]> {
  const tarballs = children.filter((child) => child.endsWith(expectedFileType));
  if (!children.includes(publishOrderFileName)) {
    return tarballs;
  }

  const orderPath = path.resolve(distFolder, publishOrderFileName);
  const parsed = JSON.parse(await fs.readFile(orderPath, "utf-8"));
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    console.error(`${publishOrderFileName} must be a JSON array of tarball file names`);
    process.exit(1);
  }

  const ordered = parsed as string[];
  const expected = new Set(tarballs);
  const seen = new Set<string>();
  for (const child of ordered) {
    if (!child.endsWith(expectedFileType)) {
      console.error(`${publishOrderFileName} includes a non-${expectedFileType} entry: ${child}`);
      process.exit(1);
    }
    if (!expected.has(child)) {
      console.error(`${publishOrderFileName} includes ${child}, but it is not present in ${buildFolderName}`);
      process.exit(1);
    }
    if (seen.has(child)) {
      console.error(`${publishOrderFileName} includes ${child} more than once`);
      process.exit(1);
    }
    seen.add(child);
  }

  const missing = tarballs.filter((child) => !seen.has(child));
  if (missing.length > 0) {
    console.error(`${publishOrderFileName} is missing tarballs: ${missing.join(", ")}`);
    process.exit(1);
  }

  return ordered;
}
