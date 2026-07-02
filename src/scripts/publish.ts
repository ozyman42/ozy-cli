import * as path from "path";
import * as fs from "fs/promises";

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
    const prefix = isBad ? "\\033[0;31m" : "";
    const suffix = isBad ? "\\033[0m" : "";
    console.log(`- ${prefix}${child}${suffix}`);
  }
}
for (const child of children) {
  const fullPath = path.resolve(distFolder, child).toLocaleLowerCase();
  const command = `npm publish ./${buildFolderName}/${child} --tag ${path.basename(fullPath, expectedFileType)}`;
  console.log(command);
  await Bun.$`${command}`;
}
