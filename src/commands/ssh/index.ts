import { Command } from 'commander';
import { skCredential } from './get-sk-credential';

export const ssh = new Command('ssh')
  .summary('ssh related utility commands');

[skCredential]
  .forEach(cmd => { ssh.addCommand(cmd) });
