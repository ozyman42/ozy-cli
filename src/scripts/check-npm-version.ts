const { name, version } = await Bun.file("package.json").json();

const res = await fetch(`https://registry.npmjs.org/${name}/${version}`);
if (res.status === 200) {
  console.error(`✗ ${name}@${version} is already published on npm`);
  process.exit(1);
}
