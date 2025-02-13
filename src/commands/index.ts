import { program } from 'commander';
import { git } from './git';

program.name('ozy');

[git]
  .forEach(cmd => { program.addCommand(cmd) });

program.parse();
