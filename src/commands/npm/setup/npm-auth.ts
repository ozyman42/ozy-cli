import { $ } from 'bun';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { Effect, Option } from 'effect';
import { log } from '../../../common/log';

const npmrcPath = `${homedir()}/.npmrc`;
const TOKEN_RE = /^\/\/registry\.npmjs\.org\/:_authToken=(\S+)$/m;

function readNpmrc(): string {
  try { return readFileSync(npmrcPath, 'utf8'); } catch { return ''; }
}

function stripTokenFromDisk(): void {
  const content = readNpmrc();
  const stripped = content.replace(TOKEN_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!stripped) {
    try { unlinkSync(npmrcPath); } catch {}
  } else {
    writeFileSync(npmrcPath, stripped + '\n');
  }
}

async function whoamiWithToken(token: string): Promise<Option.Option<string>> {
  const result = await $`npm whoami`
    .env({ ...process.env, NODE_AUTH_TOKEN: token })
    .quiet().nothrow();
  if (result.exitCode !== 0) return Option.none();
  return Option.some(result.stdout.toString().trim());
}

export function acquireToken(): Effect.Effect<{ token: string; user: string }, string> {
  return Effect.tryPromise({
    try: async () => {
      const existing = readNpmrc().match(TOKEN_RE)?.[1];
      if (existing) {
        const userOption = await whoamiWithToken(existing);
        if (Option.isSome(userOption)) {
          stripTokenFromDisk();
          return { token: existing, user: userOption.value };
        }
      }

      log('  not logged in — opening npm login...');
      await $`npm login`.nothrow();

      const token = readNpmrc().match(TOKEN_RE)?.[1];
      if (!token) throw new Error('npm login did not produce a token — try running "npm login" manually');

      const userOption = await whoamiWithToken(token);
      if (Option.isNone(userOption)) throw new Error('npm login succeeded but token verification failed');

      stripTokenFromDisk();
      return { token, user: userOption.value };
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}
