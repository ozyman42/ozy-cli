import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import type { EffectGen } from "effective-modules";
import { STANDARD_REMOTE_PREFIX } from "@/common/constants";

export interface Submodule {
  name: string;
  path: string;
  url: string;
}

// git@host:org/repo.git or git@host:repo.git
const SSH_URL_RE = /^git@[^:]+:.+\.git$/;
const SSH_URL_HOST_RE = /^git@[^:]+:(.+)$/;

export class Gitmodules {
  private constructor(
    private readonly path: string,
    private readonly repoRoot: string,
    private readonly modules: Submodule[],
    private readonly rawContent: string,
  ) {}

  public static *fromRepoRoot(repoRoot: string): EffectGen<Gitmodules, string> {
    const path = resolve(repoRoot, ".gitmodules");

    const content = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (e) => e instanceof Error ? e.message : String(e),
    });

    const modules = Gitmodules
      .parse(content)
      .map(Gitmodules.normalizeRemote)
      .sort((a, b) => a.name.localeCompare(b.name));

    const serialized = modules
      .map((m) => `[submodule "${m.name}"]\n\tpath = ${m.path}\n\turl = ${m.url}`)
      .join("\n") + "\n";

    const result = new Gitmodules(path, repoRoot, modules, serialized);
    const errors = result.validate();
    if (errors.length) {
      return yield* Effect.fail(`Validation errors in .gitmodules:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    }

    if (serialized !== content) {
      yield* Effect.tryPromise({
        try: () => writeFile(resolve(repoRoot, '.gitmodules'), serialized, 'utf8'),
        catch: (e) => e instanceof Error ? e.message : String(e),
      });
      yield* Effect.log('Updated .gitmodules.');
    }

    return result;
  }

  private static parse(content: string): Submodule[] {
    const modules: Submodule[] = [];
    let current: Partial<Submodule> | null = null;

    for (const line of content.split("\n")) {
      const headerMatch = line.match(/^\[submodule "(.+)"\]$/);
      if (headerMatch) {
        if (current) modules.push(current as Submodule);
        current = { name: headerMatch[1] };
        continue;
      }
      const kvMatch = line.match(/^\s+(\w+)\s*=\s*(.+)$/);
      if (kvMatch && current) {
        const [, key, value] = kvMatch;
        if (key === "path" || key === "url") current[key] = value.trim();
      }
    }
    if (current) modules.push(current as Submodule);
    return modules;
  }

  private static normalizeRemote(m: Submodule): Submodule {
    if (m.url.startsWith(STANDARD_REMOTE_PREFIX)) return m;
    const match = m.url.match(SSH_URL_HOST_RE);
    // TODO: we should probably move this logic to be alongside validate
    if (!match) return m; // malformed URL — left as-is, validate() will report it
    const normalizedUrl = `${STANDARD_REMOTE_PREFIX}${match[1]}`;
    console.warn(`- updating submodule "${m.name}" remote: ${m.url} -> ${normalizedUrl}`);
    return { ...m, url: normalizedUrl };
  }

  get list(): readonly Submodule[] {
    return this.modules;
  }

  get content(): string {
    return this.rawContent;
  }

  private validate(): string[] {
    const errors: string[] = [];
    const names = new Set<string>();
    const paths = new Set<string>();
    const urls = new Set<string>();

    for (const m of this.modules) {
      if (names.has(m.name)) errors.push(`Duplicate name: "${m.name}"`);
      else names.add(m.name);

      if (paths.has(m.path)) errors.push(`Duplicate path: "${m.path}" (submodule "${m.name}")`);
      else paths.add(m.path);

      if (urls.has(m.url)) errors.push(`Duplicate url: "${m.url}" (submodule "${m.name}")`);
      else urls.add(m.url);

      if (!SSH_URL_RE.test(m.url))
        errors.push(`Invalid url for "${m.name}": ${m.url}`);

      if (!existsSync(resolve(this.repoRoot, m.path)))
        errors.push(`Path does not exist for "${m.name}": ${m.path}`);
    }

    return errors;
  }
}
