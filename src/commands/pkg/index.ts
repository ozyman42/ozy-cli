import { Command } from 'commander';
import { publish } from './publish';

export const pkg = new Command('pkg')
  .summary('package creation and publishing utilities');

[publish]
  .forEach(cmd => { pkg.addCommand(cmd) });
