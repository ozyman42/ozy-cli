import { version } from "../../package.json";
import { program } from 'commander';
import { git } from './git';
import { npm } from './npm';
import { upgrade } from './upgrade';

program.name('ozy').version(version);

[git, npm, upgrade]
  .forEach(cmd => { program.addCommand(cmd) });

program.parse();

if (process.argv.length <= 2) program.help();
