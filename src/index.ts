import { program } from 'commander';
import { gitSetup } from './git';

program
  .command('git')
  .summary('setup git in repo for verified commits')
  .action(gitSetup);

program.parse();
