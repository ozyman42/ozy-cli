import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Submodule {
  name: string;
  path: string;
  url: string;
}

export type Gitmodules = Submodule[];

// git@host:org/repo.git or git@host:repo.git
const SSH_URL_RE = /^git@[^:]+:.+\.git$/;

export function parse(content: string): Gitmodules {
  const modules: Gitmodules = [];
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

export function validate(modules: Gitmodules, repoRoot: string): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();
  const urls = new Set<string>();

  for (const m of modules) {
    if (names.has(m.name)) errors.push(`Duplicate name: "${m.name}"`);
    else names.add(m.name);

    if (paths.has(m.path)) errors.push(`Duplicate path: "${m.path}" (submodule "${m.name}")`);
    else paths.add(m.path);

    if (urls.has(m.url)) errors.push(`Duplicate url: "${m.url}" (submodule "${m.name}")`);
    else urls.add(m.url);

    if (!SSH_URL_RE.test(m.url))
      errors.push(`Invalid url for "${m.name}": ${m.url}`);

    if (!existsSync(resolve(repoRoot, m.path)))
      errors.push(`Path does not exist for "${m.name}": ${m.path}`);
  }

  return errors;
}

export function serialize(modules: Gitmodules): string {
  return modules
    .map((m) => `[submodule "${m.name}"]\n\tpath = ${m.path}\n\turl = ${m.url}`)
    .join("\n") + "\n";
}

export function sorted(modules: Gitmodules): Gitmodules {
  return [...modules].sort((a, b) => a.name.localeCompare(b.name));
}
