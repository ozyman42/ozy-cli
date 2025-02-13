import { Command } from 'commander';
import { type Result } from './result';
import { log } from './log';

export function makeCommand<E>(name: string, description: string, 
  action: () => Promise<Result<true, E>>): Command {
  return new Command(name)
    .description(description)
    .action(async () => {
      const result = await action();
      if (!result.success) {
        log(`${result.error}: ${result.reason}`);
      }
      process.exit();
    })
}
