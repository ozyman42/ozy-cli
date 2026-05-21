import { Command } from 'commander';
import { setup } from './setup';
import { hosts } from './hosts';
import { syncSubmodules } from './sync-submodules';

export const git = new Command('git')
  .summary('setup git in repo for verified commits');

[setup, hosts, syncSubmodules]
  .forEach(cmd => { git.addCommand(cmd) });
