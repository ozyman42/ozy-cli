import { Command } from 'commander';
import { setup } from './setup';

export const npm = new Command('npm')
  .summary('npm package management utilities');

[setup]
  .forEach(cmd => { npm.addCommand(cmd) });
