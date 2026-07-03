import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { validatePackageJson } from './package-json-validate';
import { parseGithubOwnerRepo } from './git-remote';
import { workflowExists, createWorkflow } from './workflow';
import { Option } from "effect";

// ── validatePackageJson ──────────────────────────────────────────────────────

describe('validatePackageJson', () => {
  const base = {
    name: '@scope/pkg',
    version: '1.0.0',
    repository: { type: 'git', url: 'git+https://github.com/owner/repo.git' },
    publishConfig: { access: 'public' as const, provenance: true },
    scripts: { build: 'bun run build' },
    files: ['dist'],
  };

  test('returns no issues for a valid package', () => {
    expect(validatePackageJson(base)).toEqual([]);
  });

  test('fatal: missing version', () => {
    const issues = validatePackageJson({ ...base, version: '' });
    expect(issues.some(i => i.field === 'version' && i.fatal)).toBe(true);
  });

  test('fatal: missing build script', () => {
    const issues = validatePackageJson({ ...base, scripts: {} });
    expect(issues.some(i => i.field === 'scripts.build' && i.fatal)).toBe(true);
  });

  test('non-fatal: missing repository', () => {
    const issues = validatePackageJson({ ...base, repository: undefined as any });
    expect(issues.some(i => i.field === 'repository' && !i.fatal)).toBe(true);
  });

  test('non-fatal: invalid repository url', () => {
    const issues = validatePackageJson({ ...base, repository: { type: 'git', url: 'git+.git' } });
    expect(issues.some(i => i.field === 'repository.url' && !i.fatal)).toBe(true);
  });

  test('non-fatal: publishConfig.access not public', () => {
    const issues = validatePackageJson({ ...base, publishConfig: { access: 'restricted', provenance: true } });
    expect(issues.some(i => i.field === 'publishConfig.access')).toBe(true);
  });

  test('non-fatal: publishConfig.provenance not true', () => {
    const issues = validatePackageJson({ ...base, publishConfig: { access: 'public', provenance: false } });
    expect(issues.some(i => i.field === 'publishConfig.provenance')).toBe(true);
  });

  test('non-fatal: dist not in files', () => {
    const issues = validatePackageJson({ ...base, files: ['src'] });
    expect(issues.some(i => i.field === 'files')).toBe(true);
  });
});

// ── parseGithubOwnerRepo ─────────────────────────────────────────────────────

describe('parseGithubOwnerRepo', () => {
  test('parses https url', () => {
    expect(parseGithubOwnerRepo('https://github.com/owner/repo.git')).toEqual(Option.some({ owner: 'owner', repo: 'repo' }));
  });

  test('parses https url without .git', () => {
    expect(parseGithubOwnerRepo('https://github.com/owner/repo')).toEqual(Option.some({ owner: 'owner', repo: 'repo' }));
  });

  test('parses standard ssh url', () => {
    expect(parseGithubOwnerRepo('git@github.com:owner/repo.git')).toEqual(Option.some({ owner: 'owner', repo: 'repo' }));
  });

  test('parses ssh alias url', () => {
    expect(parseGithubOwnerRepo('git@github-ozyman42:ozyman42/test.git')).toEqual(Option.some({ owner: 'ozyman42', repo: 'test' }));
  });

  test('returns null for unrecognised url', () => {
    expect(parseGithubOwnerRepo('not-a-url')).toBeNull();
  });
});

// ── workflow helpers ─────────────────────────────────────────────────────────

describe('workflow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ozy-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('workflowExists returns false when missing', async () => {
    expect(await workflowExists(tmpDir)).toBe(false);
  });

  test('createWorkflow creates a valid yaml file', async () => {
    await createWorkflow(tmpDir);
    expect(await workflowExists(tmpDir)).toBe(true);
    const content = await fs.readFile(path.join(tmpDir, '.github/workflows/publish.yml'), 'utf8');
    expect(content).toContain('npm publish dist/');
    expect(content).toContain('id-token: write');
    expect(content).toContain('bun run build');
  });

  test('createWorkflow is idempotent', async () => {
    await createWorkflow(tmpDir);
    await createWorkflow(tmpDir);
    expect(await workflowExists(tmpDir)).toBe(true);
  });
});
