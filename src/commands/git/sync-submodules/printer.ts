import type { Submodule } from "../ozy-cli/src/commands/git/sync-submodules/gitmodules";
import type { GitConfigSubmodule, ModuleDirInfo, IndexGitlink, WorkingTreeGitEntry } from "../ozy-cli/src/commands/git/sync-submodules/git-state";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

interface Field {
  key?: string;
  value: string;
  error?: string;
}

function renderField(f: Field, indent: string): string {
  const text = f.key !== undefined ? `${indent}  ${f.key}=${f.value}` : `${indent}  ${f.value}`;
  return f.error ? `${text}  ${RED}← ${f.error}${RESET}` : text;
}

export abstract class PrintableItem {
  abstract header(): string;
  headerError(): string | undefined { return undefined; }
  abstract fields(): Field[];

  print(indent = "  ") {
    const e = this.headerError();
    console.log(e ? `${indent}${this.header()}  ${RED}← ${e}${RESET}` : `${indent}${this.header()}`);
    for (const f of this.fields()) console.log(renderField(f, indent));
  }

  static printGroup(header: string, items: PrintableItem[]) {
    console.log(`\n=== ${header} ===`);
    for (const item of items) item.print();
  }
}

/** Red single-line entry for something expected but absent in a section. */
export class GhostItem extends PrintableItem {
  constructor(private label: string, private message: string) { super(); }
  header() { return this.label; }
  fields() { return []; }
  print(indent = "  ") {
    console.log(`${RED}${indent}${this.label}  ← ${this.message}${RESET}`);
  }
}

export class GitmodulesEntryItem extends PrintableItem {
  constructor(private m: Submodule) { super(); }
  header() { return `[${this.m.name}]`; }
  fields(): Field[] {
    return [
      { key: "path", value: this.m.path },
      { key: "url", value: this.m.url },
    ];
  }
}

export class GitConfigEntryItem extends PrintableItem {
  constructor(
    private e: GitConfigSubmodule,
    private gm: Submodule | undefined,
    private isDuplicate: boolean,
  ) { super(); }

  header() { return `[${this.e.name}]`; }

  headerError() {
    if (this.isDuplicate) return "duplicate";
    if (!this.gm) return "not in .gitmodules";
  }

  fields(): Field[] {
    const { e, gm } = this;
    return [
      { key: "path", value: e.path ?? "(none)", error: gm && e.path !== gm.path ? `expected ${gm.path}` : undefined },
      { key: "url", value: e.url ?? "(none)", error: gm && e.url !== gm.url ? `expected ${gm.url}` : undefined },
      { key: "active", value: String(e.active ?? "(unset)") },
    ];
  }
}

export class ModuleDirItem extends PrintableItem {
  constructor(
    private d: ModuleDirInfo,
    private gm: Submodule | undefined,
  ) { super(); }

  header() { return this.d.relativePath; }
  headerError() { return !this.gm ? "not in .gitmodules" : undefined; }

  fields(): Field[] {
    const { d, gm } = this;
    return [
      { key: "remote", value: d.remoteUrl ?? "(none)", error: gm && d.remoteUrl && d.remoteUrl !== gm.url ? `expected ${gm.url}` : undefined },
    ];
  }
}

export class IndexGitlinkItem extends PrintableItem {
  constructor(
    private e: IndexGitlink,
    private knownPath: boolean,
  ) { super(); }

  header() { return this.e.path; }
  headerError() { return !this.knownPath ? "not in .gitmodules" : undefined; }
  fields(): Field[] {
    return [{ key: "commit", value: this.e.commit.slice(0, 8) }];
  }
}

export class WorkingTreeItem extends PrintableItem {
  constructor(private e: WorkingTreeGitEntry) { super(); }

  header() { return this.e.path; }

  headerError() {
    if (this.e.type === "missing") return "missing";
    if (this.e.type === "dir") return "expected gitdir file, got directory";
  }

  fields(): Field[] {
    if (this.e.type === "file") return [{ value: `gitdir -> ${this.e.gitdirTarget}` }];
    return [];
  }
}
