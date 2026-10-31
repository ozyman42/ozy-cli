import { Command } from 'commander';
import { Effect, pipe, Result } from 'effect';
import { effunct, type EffectGen } from 'effective-modules';
import { log } from './log';

export function makeCommand(name: string, description: string,
  action: () => EffectGen<void, string>): Command {
  return new Command(name)
    .description(description)
    .action(async () => {
      const result = await Effect.runPromise(pipe(effunct(action)(), Effect.result));
      if (Result.isFailure(result)) {
        log(`✗ ${result.failure}`);
        process.exit(1);
      }
      process.exit(0);
    });
}
