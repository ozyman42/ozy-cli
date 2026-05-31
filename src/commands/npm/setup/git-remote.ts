import { $ } from 'bun';
import { Effect, Option } from 'effect';

export interface RepoAccess {
  owner: string;
  repo: string;
  canPush: boolean;
}

export interface CreatedRepo {
  owner: string;
  repo: string;
  url: string;
  sshUrl: string;
}

// Handles https://github.com/owner/repo.git, git@github.com:owner/repo.git,
// and SSH aliases like github-ozyman42:owner/repo.git
export function parseGithubOwnerRepo(url: string): Option.Option<{ owner: string; repo: string }> {
  const https = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return Option.some({ owner: https[1]!, repo: https[2]! });
  const alias = url.match(/^[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (alias) return Option.some({ owner: alias[1]!, repo: alias[2]! });
  return Option.none();
}

async function viewRepo(nameWithOwner: string): Promise<Option.Option<CreatedRepo>> {
  const view = await $`gh repo view ${nameWithOwner} --json name,owner,url,sshUrl`.quiet().nothrow();
  if (view.exitCode !== 0) return Option.none();
  try {
    const data = JSON.parse(view.stdout.toString());
    return Option.some({ owner: data.owner.login, repo: data.name, url: data.url, sshUrl: data.sshUrl });
  } catch {
    return Option.none();
  }
}

export function ensureGitHubRepo(name: string, isPrivate = false): Effect.Effect<{ repo: CreatedRepo; created: boolean }, string> {
  return Effect.tryPromise({
    try: async () => {
      const whoami = await $`gh api user --jq .login`.quiet().nothrow();
      const owner = whoami.exitCode === 0 ? whoami.stdout.toString().trim() : null;

      if (owner) {
        const existingOption = await viewRepo(`${owner}/${name}`);
        if (Option.isSome(existingOption)) return { repo: existingOption.value, created: false };
      }

      const visibility = isPrivate ? '--private' : '--public';
      const create = await $`gh repo create ${name} ${visibility}`.quiet().nothrow();
      if (create.exitCode !== 0) {
        throw new Error(`gh repo create failed: ${create.stderr.toString().trim()}`);
      }
      const createdOption = await viewRepo(name);
      if (Option.isNone(createdOption)) throw new Error(`repo created but could not retrieve details for "${name}"`);
      return { repo: createdOption.value, created: true };
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}

export async function checkGitHubAccess(remoteUrl: string): Promise<Option.Option<RepoAccess>> {
  const parsedOption = parseGithubOwnerRepo(remoteUrl);
  if (Option.isNone(parsedOption)) return Option.none();
  const { owner, repo } = parsedOption.value;

  const result = await $`gh api repos/${owner}/${repo}`.quiet().nothrow();
  if (result.exitCode !== 0) return Option.none();

  let data: any;
  try {
    data = JSON.parse(result.stdout.toString());
  } catch {
    return Option.none();
  }

  return Option.some({ owner, repo, canPush: data?.permissions?.push === true });
}
