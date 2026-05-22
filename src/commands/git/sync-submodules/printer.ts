import type { Gitmodules } from "./gitmodules";
import type { GitState } from "./git-state";
import type { Fix } from "./fix";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ok = `${GREEN}✓${RESET}`;
const fail = (msg: string) => `${RED}✗ ${msg}${RESET}`;
const fsName = (s: string) => `${CYAN}${s}${RESET}`;
const key = (s: string) => `${DIM}${s}${RESET}`;

interface Line {
  label: string;
  isKey?: boolean;  // dim key style instead of cyan fs style
  value?: string;
  status?: string;
  children?: Line[];
}

function render(lines: Line[], prefix = ""): void {
  for (let i = 0; i < lines.length; i++) {
    const last = i === lines.length - 1;
    const branch = last ? "└── " : "├── ";
    const child = last ? "    " : "│   ";
    const l = lines[i];
    const label = l.isKey ? key(l.label) : fsName(l.label);
    let out = `${prefix}${branch}${label}`;
    if (l.value !== undefined) out += `: ${l.value}`;
    if (l.status !== undefined) out += `  ${l.status}`;
    console.log(out);
    if (l.children?.length) render(l.children, prefix + child);
  }
}

function buildPathTree(parts: string[], children: Line[]): Line {
  if (parts.length === 1) return { label: parts[0], children };
  return { label: parts[0], children: [buildPathTree(parts.slice(1), children)] };
}

function resultLine(label: string, result: string | { error: string } | undefined): Line {
  if (result === undefined) return { label, isKey: true, status: fail("unknown") };
  if (typeof result === "string") return { label, isKey: true, value: result };
  return { label, isKey: true, status: fail(result.error) };
}

function moduleHasIssues(
  m: { path: string; url: string },
  cfg: { path?: string; url?: string } | undefined,
  dir: ModuleDirInfo | undefined,
  idx: IndexGitlink | undefined,
  headSha: string | undefined,
  wt: WorkingTreeGitEntry | undefined,
): boolean {
  if (!cfg) return true;
  if (cfg.path !== m.path || cfg.url !== m.url) return true;
  if (!dir) return true;
  if (!idx) return true;
  if (headSha && idx.commit !== headSha) return true;
  if (!wt || wt.type === "missing" || wt.type === "dir") return true;
  if (typeof wt.headCommit !== "string") return true;
  if (typeof wt.remote !== "string" || wt.remote !== m.url) return true;
  return false;
}

export function printSyncState(modules: Gitmodules, state: GitState): void {
  const byName = new Map(state.config.map((c) => [c.name, c]));
  const byPath = new Map(state.moduleDirs.map((d) => [d.relativePath, d]));
  const byIndexPath = new Map(state.index.map((i) => [i.path, i]));
  const byTreePath = new Map(state.workingTree.map((w) => [w.path, w]));
  const modulePaths = new Set(modules.map((m) => m.path));
  const moduleNames = new Set(modules.map((m) => m.name));

  console.log("=== submodules ===");

  for (const m of modules) {
    const cfg = byName.get(m.name);
    const dir = byPath.get(m.path);
    const idx = byIndexPath.get(m.path);
    const wt = byTreePath.get(m.path);
    const headSha = typeof wt?.headCommit === "string" ? wt.headCommit : undefined;

    console.log(`\n${BOLD}[${m.name}]${RESET}`);

    if (!moduleHasIssues(m, cfg, dir, idx, headSha, wt)) {
      console.log(`└── ${ok}`);
      continue;
    }

    // .gitmodules
    const gitmodulesNode: Line = {
      label: ".gitmodules",
      children: [
        { label: "path", isKey: true, value: m.path },
        { label: "url", isKey: true, value: m.url },
      ],
    };

    // .git/config
    let configNode: Line;
    if (!cfg) {
      configNode = { label: "config", status: fail("missing") };
    } else {
      configNode = {
        label: "config",
        children: [
          {
            label: "path",
            isKey: true,
            value: cfg.path ?? "(missing)",
            status: cfg.path === m.path ? ok : fail(`expected ${m.path}`),
          },
          {
            label: "url",
            isKey: true,
            value: cfg.url ?? "(missing)",
            status: cfg.url === m.url ? ok : fail(`expected ${m.url}`),
          },
        ],
      };
    }

    // .git/modules
    const modulesNode: Line = {
      label: "modules",
      children: [{ label: m.path, status: dir ? ok : fail("missing") }],
    };

    // .git/index
    let indexNode: Line;
    if (!idx) {
      indexNode = { label: "index", status: fail("missing") };
    } else {
      const idxSha8 = idx.commit.slice(0, 8);
      const matches = headSha && idx.commit === headSha;
      const mismatches = headSha && idx.commit !== headSha;
      indexNode = {
        label: "index",
        value: idxSha8,
        status: matches ? ok : mismatches ? fail(`head is ${headSha.slice(0, 8)}`) : undefined,
      };
    }

    const dotGitNode: Line = {
      label: ".git",
      children: [configNode, modulesNode, indexNode],
    };

    // working tree leaves
    const wtLeaves: Line[] = [];

    if (!wt || wt.type === "missing") {
      wtLeaves.push({ label: ".git", status: fail("missing") });
    } else if (wt.type === "dir") {
      wtLeaves.push({ label: ".git", status: fail("directory (standalone clone)") });
    } else {
      wtLeaves.push({ label: ".git", value: `gitdir → ${wt.gitdirTarget}` });
    }

    if (wt) {
      const head = headSha ?? wt.headCommit;
      wtLeaves.push(resultLine("head", typeof head === "string" ? head.slice(0, 8) : head));

      if (typeof wt.remote === "string") {
        wtLeaves.push({
          label: "remote",
          isKey: true,
          value: wt.remote,
          status: wt.remote === m.url ? ok : fail(`expected ${m.url}`),
        });
      } else {
        wtLeaves.push(resultLine("remote", wt.remote));
      }
    }

    const workingTreeNode = buildPathTree(m.path.split("/"), wtLeaves);

    render([gitmodulesNode, dotGitNode, workingTreeNode]);
  }

  // Stale entries
  const staleConfig = state.config.filter((c) => !moduleNames.has(c.name));
  const staleDirs = state.moduleDirs.filter((d) => !modulePaths.has(d.relativePath));
  const staleIndex = state.index.filter((i) => !modulePaths.has(i.path));

  if (staleConfig.length || staleDirs.length || state.orphanModuleDirs.length || staleIndex.length) {
    console.log(`\n${RED}${BOLD}=== stale (not in .gitmodules) ===${RESET}`);
    const staleNodes: Line[] = [];

    if (staleConfig.length) {
      staleNodes.push({
        label: ".git/config",
        children: staleConfig.map((c) => ({ label: c.name })),
      });
    }
    if (staleDirs.length || state.orphanModuleDirs.length) {
      staleNodes.push({
        label: ".git/modules",
        children: [
          ...staleDirs.map((d) => ({ label: d.relativePath })),
          ...state.orphanModuleDirs.map((d) => ({ label: d })),
        ],
      });
    }
    if (staleIndex.length) {
      staleNodes.push({
        label: ".git/index",
        children: staleIndex.map((i) => ({ label: i.path, isKey: true, value: i.commit.slice(0, 8) })),
      });
    }

    render(staleNodes);
  }
}

type FixTree = Map<string, { subtree: FixTree; fixes: Fix[] }>;

function addToFixTree(tree: FixTree, fix: Fix, depth = 0): void {
  const seg = fix.location[depth];
  if (!tree.has(seg)) tree.set(seg, { subtree: new Map(), fixes: [] });
  const node = tree.get(seg)!;
  if (depth === fix.location.length - 1) {
    node.fixes.push(fix);
  } else {
    addToFixTree(node.subtree, fix, depth + 1);
  }
}

function fixTreeToLines(tree: FixTree): Line[] {
  const lines: Line[] = [];
  for (const [label, { subtree, fixes }] of tree) {
    const children = fixTreeToLines(subtree);
    if (fixes.length > 0) {
      for (const fix of fixes) {
        const actionStr = fix.action === "deleted" ? `${RED}deleted${RESET}` : `${GREEN}synced${RESET}`;
        const status = fix.detail ? `${actionStr}  ${fix.detail}` : actionStr;
        lines.push({ label, status, children: children.length > 0 ? children : undefined });
      }
    } else {
      lines.push({ label, children });
    }
  }
  return lines;
}

export function printFixes(fixes: Fix[]): void {
  if (fixes.length === 0) return;
  const tree: FixTree = new Map();
  for (const fix of fixes) addToFixTree(tree, fix);
  console.log("\napplied fixes:");
  render(fixTreeToLines(tree));
}
