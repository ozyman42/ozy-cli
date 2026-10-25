import { program } from 'commander';
import { git } from './git';
import { pkg } from './pkg';
import { upgrade } from './upgrade';
import { ssh } from "./ssh";
import { cloudflare } from "./cloudflare";
import { daemons } from "./daemons";
import { CLI_CMD_NAME, CURRENT_VERSION } from '@/common/constants';

program.name(CLI_CMD_NAME).version(CURRENT_VERSION);

[git, pkg, ssh, cloudflare, daemons, upgrade]
  .forEach(cmd => { program.addCommand(cmd) });

program.parse();

if (process.argv.length <= 2) program.help();
