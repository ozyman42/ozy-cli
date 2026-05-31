import { program } from 'commander';
import { git } from './git';
import { npm } from './npm';
import { upgrade } from './upgrade';
import { ssh } from "./ssh";
import { CLI_CMD_NAME, CURRENT_VERSION } from '@/common/constants';

program.name(CLI_CMD_NAME).version(CURRENT_VERSION);

[git, npm, ssh, upgrade]
  .forEach(cmd => { program.addCommand(cmd) });

program.parse();

if (process.argv.length <= 2) program.help();
