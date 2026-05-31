import { dlopen, FFIType } from "bun:ffi";
import { execSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { Option } from "effect";
import type { CallerProcess } from "./interface";

const isMacOS = process.platform === 'darwin';

// ---- FFI: getsockopt ----

const SOL_LOCAL = 0;           // macOS: SOL_LOCAL (sys/un.h)
const LOCAL_PEERPID = 2;       // macOS: LOCAL_PEERPID (sys/un.h)
const SOL_SOCKET_LINUX = 1;    // Linux: SOL_SOCKET
const SO_PEERCRED_LINUX = 17;  // Linux: SO_PEERCRED

type GetsockoptFn = (fd: number, level: number, optname: number, optval: Uint8Array, optlen: Uint32Array) => number;
let _getsockopt: GetsockoptFn | undefined;

function getsockoptSymbol(): GetsockoptFn {
  if (!_getsockopt) {
    const libName = isMacOS ? 'libSystem.B.dylib' : 'libc.so.6';
    const lib = dlopen(libName, {
      getsockopt: {
        args: [FFIType.int, FFIType.int, FFIType.int, FFIType.ptr, FFIType.ptr],
        returns: FFIType.int,
      },
    });
    _getsockopt = lib.symbols['getsockopt'] as unknown as GetsockoptFn;
  }
  return _getsockopt;
}

function getPeerPidFromFd(fd: number): number {
  const getsockopt = getsockoptSymbol();
  if (isMacOS) {
    const pidBuf = new Uint8Array(4);
    const lenBuf = new Uint32Array([4]);
    const ret = getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pidBuf, lenBuf);
    if (ret !== 0) throw new Error(`getsockopt(LOCAL_PEERPID) failed with ret=${ret}`);
    return new DataView(pidBuf.buffer).getInt32(0, true);
  } else {
    // Linux: struct ucred { pid_t pid; uid_t uid; gid_t gid; } = 12 bytes
    const credBuf = new Uint8Array(12);
    const lenBuf = new Uint32Array([12]);
    const ret = getsockopt(fd, SOL_SOCKET_LINUX, SO_PEERCRED_LINUX, credBuf, lenBuf);
    if (ret !== 0) throw new Error(`getsockopt(SO_PEERCRED) failed with ret=${ret}`);
    return new DataView(credBuf.buffer).getInt32(0, true);
  }
}

// ---- Per-PID info resolution ----

interface ProcessInfo {
  ppid: number;
  command: string;
  cwd: Option.Option<string>;
}

function getProcessInfoMacOS(pid: number): ProcessInfo {
  let psOut: string;
  try {
    psOut = execSync(`ps -p ${pid} -o ppid= -o args=`, { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error(`PID ${pid} exited before caller info could be read`);
  }
  const firstSpace = psOut.indexOf(' ');
  if (firstSpace < 0) throw new Error(`Unexpected ps output for PID ${pid}: "${psOut}"`);
  const ppid = parseInt(psOut.slice(0, firstSpace).trim(), 10);
  const command = psOut.slice(firstSpace + 1).trim();

  // lsof exits non-zero on macOS when it hits permission errors on other fds even if it
  // successfully located the cwd entry, so we check output regardless of exit code.
  const lsofResult = Bun.spawnSync(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const lsofOut = lsofResult.stdout.toString().trim();
  const cwdLine = lsofOut.split('\n').find(l => l.startsWith('n'));
  const cwd = cwdLine ? Option.some(cwdLine.slice(1)) : Option.none();

  return { ppid, command, cwd };
}

function getProcessInfoLinux(pid: number): ProcessInfo {
  const rawCmdline = readFileSync(`/proc/${pid}/cmdline`);
  const command = rawCmdline.toString().replace(/\0+$/, '').split('\0').join(' ');
  if (!command) throw new Error(`Empty cmdline for PID ${pid}`);

  let cwd: Option.Option<string>;
  try {
    cwd = Option.some(readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    cwd = Option.none();
  }

  const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
  const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
  if (!ppidMatch) throw new Error(`No PPid in /proc/${pid}/status`);
  const ppid = parseInt(ppidMatch[1], 10);

  return { ppid, command, cwd };
}

function getProcessInfoWindows(pid: number): ProcessInfo {
  const infoOut = execSync(
    `powershell -NoProfile -Command "` +
    `$p = Get-WmiObject Win32_Process -Filter 'ProcessId=${pid}'; ` +
    `if ($p) { Write-Output \\\"$($p.ParentProcessId)|$($p.CommandLine)\\\" }"`,
    { encoding: 'utf-8' }
  ).trim();
  if (!infoOut) throw new Error(`WMI returned no result for PID ${pid}`);
  const pipeIdx = infoOut.indexOf('|');
  if (pipeIdx < 0) throw new Error(`Unexpected WMI output for PID ${pid}: "${infoOut}"`);
  const ppid = parseInt(infoOut.slice(0, pipeIdx), 10);
  const command = infoOut.slice(pipeIdx + 1);

  return { ppid, command, cwd: Option.none() };
}

// ---- Chain walking ----

function walkChain(initialPid: number, getInfo: (pid: number) => ProcessInfo): CallerProcess[] {
  const chain: CallerProcess[] = [];
  let pid = initialPid;
  const visited = new Set<number>();
  let isFirst = true;
  while (pid > 0 && !visited.has(pid)) {
    visited.add(pid);
    let info: ProcessInfo;
    try {
      info = getInfo(pid);
    } catch (e) {
      if (isFirst) throw e;
      break;
    }
    chain.push({ pid, command: info.command, directory: info.cwd });
    pid = info.ppid;
    isFirst = false;
  }
  // Reverse so chain[0] = oldest ancestor, chain[N-1] = direct caller.
  // This matches the display logic in passkey-prf-page.ts which skips the common
  // ancestor prefix to show the relevant tail (git, ssh, etc.).
  return chain.reverse();
}

// ---- Public API ----

export function resolveCallerChainUnix(fd: number): CallerProcess[] {
  const pid = getPeerPidFromFd(fd);
  return walkChain(pid, isMacOS ? getProcessInfoMacOS : getProcessInfoLinux);
}

export function resolveCallerChainWindows(remotePid: number): CallerProcess[] {
  return walkChain(remotePid, getProcessInfoWindows);
}
