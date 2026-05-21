import { $ } from 'bun';

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
export function parseGithubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const https = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  // SSH alias: anything before a colon, then owner/repo
  const alias = url.match(/^[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (alias) return { owner: alias[1], repo: alias[2] };
  return null;
}

async function viewRepo(nameWithOwner: string): Promise<CreatedRepo | null> {
  const view = await $`gh repo view ${nameWithOwner} --json name,owner,url,sshUrl`.quiet().nothrow();
  if (view.exitCode !== 0) return null;
  try {
    const data = JSON.parse(view.stdout.toString());
    return { owner: data.owner.login, repo: data.name, url: data.url, sshUrl: data.sshUrl };
  } catch {
    return null;
  }
}

export async function ensureGitHubRepo(name: string, isPrivate = false): Promise<{ repo: CreatedRepo; created: boolean }> {
  // Check if a repo with this name already exists for the current user
  const whoami = await $`gh api user --jq .login`.quiet().nothrow();
  const owner = whoami.exitCode === 0 ? whoami.stdout.toString().trim() : null;

  if (owner) {
    const existing = await viewRepo(`${owner}/${name}`);
    if (existing) return { repo: existing, created: false };
  }

  const visibility = isPrivate ? '--private' : '--public';
  const create = await $`gh repo create ${name} ${visibility}`.quiet().nothrow();
  if (create.exitCode !== 0) {
    throw new Error(`gh repo create failed: ${create.stderr.toString().trim()}`);
  }
  const created = await viewRepo(name);
  if (!created) throw new Error(`repo created but could not retrieve details for "${name}"`);
  return { repo: created, created: true };
}

export async function checkGitHubAccess(remoteUrl: string): Promise<RepoAccess | null> {
  const parsed = parseGithubOwnerRepo(remoteUrl);
  if (!parsed) return null;

  const result = await $`gh api repos/${parsed.owner}/${parsed.repo}`.quiet().nothrow();
  if (result.exitCode !== 0) return null;

  let data: any;
  try {
    data = JSON.parse(result.stdout.toString());
  } catch {
    return null;
  }

  return { ...parsed, canPush: data?.permissions?.push === true };
}
