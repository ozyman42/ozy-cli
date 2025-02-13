import { Command } from 'commander';
import { setup } from './setup';
import { hosts } from './hosts';

export const git = new Command('git')
  .summary('setup git in repo for verified commits');

[setup, hosts]
  .forEach(cmd => { git.addCommand(cmd) });
