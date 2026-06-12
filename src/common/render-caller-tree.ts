import type { CallerProcess } from "@/modules/common/os-platform/interface";
import { Option } from "effect";

const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function fmtNode(node: CallerProcess): string {
  const dir = Option.getOrElse(() => '?')(node.directory);
  return `${CYAN}${node.command}${RESET}  ${DIM}${dir}${RESET}`;
}

export function renderCallerTree(chain: CallerProcess[]): string {
  if (chain.length === 0) return '(empty)';
  const lines: string[] = [fmtNode(chain[0]!)];
  let indent = '';
  for (let i = 1; i < chain.length; i++) {
    lines.push(`${indent}└── ${fmtNode(chain[i]!)}`);
    indent += '    ';
  }
  return lines.join('\n');
}
