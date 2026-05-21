import { $ } from 'bun';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
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

async function whoamiWithToken(token: string): Promise<string | null> {
  const result = await $`npm whoami`
    .env({ ...process.env, NODE_AUTH_TOKEN: token })
    .quiet().nothrow();
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim();
}

export async function acquireToken(): Promise<{ token: string; user: string }> {
  // If there's already a token on disk, use it and immediately clear it.
  const existing = readNpmrc().match(TOKEN_RE)?.[1];
  if (existing) {
    const user = await whoamiWithToken(existing);
    if (user) {
      stripTokenFromDisk();
      return { token: existing, user };
    }
  }

  // No valid token — open browser login. npm writes the result to ~/.npmrc.
  log('  not logged in — opening npm login...');
  await $`npm login`.nothrow();

  const token = readNpmrc().match(TOKEN_RE)?.[1];
  if (!token) throw new Error('npm login did not produce a token — try running "npm login" manually');

  const user = await whoamiWithToken(token);
  if (!user) throw new Error('npm login succeeded but token verification failed');

  stripTokenFromDisk();
  return { token, user };
}
