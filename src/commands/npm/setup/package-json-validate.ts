interface Pkg {
  name: string;
  version: string;
  repository?: { type?: string; url?: string } | string;
  publishConfig?: { access?: string; provenance?: boolean };
  scripts?: Record<string, string>;
  files?: string[];
}

export interface PackageJsonIssue {
  field: string;
  issue: string;
  fatal?: boolean;
}

const GITHUB_URL_RE = /^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/;

function isValidGitHubUrl(url: string): boolean {
  return GITHUB_URL_RE.test(url);
}

function normalizeRepoUrl(url: string): string {
  if (!url.startsWith('git+')) url = `git+${url}`;
  if (!url.endsWith('.git')) url = `${url}.git`;
  return url;
}

export function validatePackageJson(pkg: Pkg): PackageJsonIssue[] {
  const issues: PackageJsonIssue[] = [];

  const repoUrl = typeof pkg.repository === 'object' ? pkg.repository?.url : pkg.repository;
  if (!repoUrl) {
    issues.push({ field: 'repository', issue: 'missing — required for provenance' });
  } else if (!isValidGitHubUrl(repoUrl)) {
    issues.push({ field: 'repository.url', issue: `not a valid GitHub URL (got "${repoUrl}")` });
  }

  if (pkg.publishConfig?.access !== 'public') {
    issues.push({ field: 'publishConfig.access', issue: 'should be "public"' });
  }
  if (pkg.publishConfig?.provenance !== true) {
    issues.push({ field: 'publishConfig.provenance', issue: 'should be true' });
  }

  if (!pkg.version) {
    issues.push({ field: 'version', issue: 'missing — add a "version" field (e.g. "0.0.1")', fatal: true });
  }

  if (!pkg.scripts?.build) {
    issues.push({ field: 'scripts.build', issue: 'missing — add a "build" script before running setup', fatal: true });
  }

  if (!pkg.files?.includes('dist')) {
    issues.push({ field: 'files', issue: '"dist" not included — built output won\'t be published' });
  }

  return issues;
}

export function buildFixedPackageJson(pkg: Pkg, repoUrl: string): Pkg {
  const url = normalizeRepoUrl(repoUrl);
  return {
    ...pkg,
    repository: { type: 'git', url },
    publishConfig: { access: 'public', provenance: true },
    files: pkg.files?.includes('dist') ? pkg.files : [...(pkg.files ?? []), 'dist'],
  };
}
