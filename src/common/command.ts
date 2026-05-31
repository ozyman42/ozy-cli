import { Command } from 'commander';
import { Effect, Result } from 'effect';
import { log } from './log';

export function makeCommand(name: string, description: string,
  action: () => Effect.Effect<void, string>): Command {
  return new Command(name)
    .description(description)
    .action(async () => {
      const result = await Effect.runPromise(action().pipe(Effect.result));
      if (Result.isFailure(result)) {
        log(`✗ ${result.failure}`);
      }
      process.exit();
    });
}
