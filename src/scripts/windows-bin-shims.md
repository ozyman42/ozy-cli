# Windows bin shim audit

This document describes what the package managers do when a package exposes
commands through `package.json#bin`, with focus on the Windows first-run repair
problem for `ozy-cli`.

The goal is mechanical: list the files created by each installer, the target
they point at, the code that creates them, and what still needs real Windows
fixture verification. Do not implement a shim-replacement strategy from memory;
use this file as the checklist.

## Package shape under discussion

Base package manifest shape:

```json
{
  "name": "@scope/tool",
  "bin": {
    "ozy": "./bin/ozy",
    "ozy-ssh-keygen": "./bin/ozy-ssh-keygen",
    "ozy-signing-agent": "./bin/ozy-signing-agent"
  },
  "optionalDependencies": {
    "@scope/tool-darwin-arm64": "1.2.3",
    "@scope/tool-darwin-x64": "1.2.3",
    "@scope/tool-linux-arm64": "1.2.3",
    "@scope/tool-linux-x64": "1.2.3",
    "@scope/tool-windows-x64": "1.2.3"
  }
}
```

Base package file shape:

```text
package/
  package.json
  bin/
    ozy
    ozy-ssh-keygen
    ozy-signing-agent
  src/
    ...
```

Each file in `bin/` can be identical JS install/repair code. The useful property
is that each command has a distinct installer-owned bin target, which gives the
package manager a chance to create one shim set per command.

Platform package shape:

```text
package/
  package.json
  multi-call-binary       # POSIX
```

```text
package/
  package.json
  multi-call-binary.exe   # Windows
```

The platform package should not be relied on to expose final command links for
the base package. A package manager generally links the bins of the package
being installed as a direct dependency/global package. It does not make an
optional dependency's `bin` entries stand in for the parent package commands in
all local/global cases.

## Implemented package-local repair strategy

The base package owns every public command through package-owned files:

```text
package/
  bin/
    ozy
    ozy-signing-agent
    ozy-ssh-keygen
```

Each file has identical JS launcher contents. The filename is the command name.
The generated base `package.json#bin` points each command at its matching file:

```json
{
  "bin": {
    "ozy": "./bin/ozy",
    "ozy-signing-agent": "./bin/ozy-signing-agent",
    "ozy-ssh-keygen": "./bin/ozy-ssh-keygen"
  }
}
```

The platform packages do not expose `bin` entries. They only contain the native
multi-call payload:

```text
multi-call-binary       # POSIX
multi-call-binary.exe   # Windows
```

At runtime, the JS launcher resolves the installed optional platform package and
materializes command-named executables next to the launchers.

POSIX first run:

```text
package/bin/ozy                  # JS launcher
package/bin/ozy-signing-agent    # JS launcher
package/bin/ozy-ssh-keygen       # JS launcher
platform/multi-call-binary       # native payload
```

The launcher materializes the first command path from the platform
`multi-call-binary`, using a hardlink first and falling back to one copy. It
then hardlinks every other command path to that first materialized command:

```text
package/bin/ozy                  # native multi-call executable after repair
package/bin/ozy-signing-agent    # hardlink to package/bin/ozy
package/bin/ozy-ssh-keygen       # hardlink to package/bin/ozy
```

Then it spawns `package/bin/ozy`. Later invocations through package-manager
`.bin` symlinks run the native command path directly.

Windows first run:

```text
package/bin/ozy                  # JS launcher; remains JS
package/bin/ozy-signing-agent    # JS launcher; remains JS
package/bin/ozy-ssh-keygen       # JS launcher; remains JS
platform/multi-call-binary.exe   # native payload
```

The launcher materializes all command `.exe` files together. It hardlinks the
first command `.exe` from `multi-call-binary.exe`, falling back to one copy when
that hardlink fails. It then hardlinks every other command `.exe` to the first
materialized `.exe`:

```text
package/bin/ozy                  # JS launcher
package/bin/ozy.exe              # native multi-call executable
package/bin/ozy-signing-agent    # JS launcher
package/bin/ozy-signing-agent.exe # hardlink to package/bin/ozy.exe
package/bin/ozy-ssh-keygen       # JS launcher
package/bin/ozy-ssh-keygen.exe   # hardlink to package/bin/ozy.exe
package/bin/installed.json       # { "version": "<platform-package-version>" }
```

Then it spawns `package/bin/ozy.exe`. Later invocations still pass through the
package-manager shim and JS launcher, but the final process image is the
command-specific `.exe`.

The Windows `installed.json` records only the platform package version. If it
does not match the currently resolved optional dependency version, or if any
command `.exe` is missing, the launcher recreates all command `.exe` files
together.

## Source links

### npm

- npm `bin-links` selects Windows shim generation here:
  https://github.com/npm/bin-links/blob/main/lib/link-bins.js
- npm `bin-links` local/global target rules:
  https://github.com/npm/bin-links/blob/main/lib/index.js
  https://github.com/npm/bin-links/blob/main/lib/bin-target.js
- npm `bin-links` calls `cmd-shim` and tracks `name`, `name.cmd`, `name.ps1`:
  https://github.com/npm/bin-links/blob/main/lib/shim-bin.js
- npm `cmd-shim` writes the actual `name`, `name.cmd`, and `name.ps1` files:
  https://github.com/npm/cmd-shim/blob/main/lib/index.js

### pnpm

- pnpm `@pnpm/link-bins` gathers package bin entries and calls
  `@zkochan/cmd-shim`:
  https://github.com/pnpm/pnpm/blob/main/pkg-manager/link-bins/src/index.ts
- pnpm `@zkochan/cmd-shim` writes shell, CMD, and PowerShell shims:
  https://github.com/pnpm/cmd-shim/blob/main/src/index.ts

### Bun package manager

- Bun chooses POSIX symlink vs Windows shim in `src/install/bin.rs`:
  https://github.com/oven-sh/bun/blob/main/src/install/bin.rs#L936-L952
- Bun writes `name.bunx` metadata and `name.exe` PE shim:
  https://github.com/oven-sh/bun/blob/main/src/install/bin.rs#L1138-L1254
- Bun's Windows shim metadata maps target extensions to launchers:
  https://github.com/oven-sh/bun/blob/main/src/install/windows-shim/BinLinkingShim.rs#L174-L260
- Bun's PE shim implementation reads adjacent `.bunx` metadata:
  https://github.com/oven-sh/bun/blob/main/src/install/windows-shim/bun_shim_impl.rs

### Yarn Classic

- Yarn Classic uses `@zkochan/cmd-shim` on Windows with
  `createPwshFile: false`, and POSIX symlinks elsewhere:
  https://github.com/yarnpkg/yarn/blob/master/src/package-linker.js#L22-L45
- Yarn Classic links package bins into `.bin` under the target install location:
  https://github.com/yarnpkg/yarn/blob/master/src/package-linker.js#L74-L94

### Yarn Berry

- Yarn Berry `nodeLinker: node-modules` builds `.bin` link maps from package
  manifests:
  https://github.com/yarnpkg/berry/blob/master/packages/plugin-nm/sources/NodeModulesLinker.ts#L1014-L1072
- Yarn Berry `nodeLinker: node-modules` writes Windows shims with
  `@zkochan/cmd-shim` and `createPwshFile: false`:
  https://github.com/yarnpkg/berry/blob/master/packages/plugin-nm/sources/NodeModulesLinker.ts#L1399-L1436
- Yarn Berry script execution creates temporary wrappers through
  `scriptUtils.makePathWrapper`:
  https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/scriptUtils.ts#L40-L50
- Yarn Berry script execution classifies native executables vs JS-like scripts:
  https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/scriptUtils.ts#L607-L632
- Yarn Berry script execution installs temporary accessible binaries:
  https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/scriptUtils.ts#L713-L739
- Yarn Berry `dlx` installs into a temporary project, then executes a workspace
  accessible binary:
  https://github.com/yarnpkg/berry/blob/master/packages/plugin-dlx/sources/commands/dlx.ts#L46-L132

## Generated files by package manager

The examples below assume this manifest:

```json
{
  "name": "@scope/tool",
  "bin": {
    "ozy": "./bin/ozy"
  }
}
```

and the package contains:

```text
package/
  bin/
    ozy
```

### npm, local dependency install on Windows

Observed from source:

- `bin-links/lib/link-bins.js` selects `shim-bin.js` on Windows.
- `bin-links/lib/bin-target.js` targets `node_modules/.bin` for non-top
  packages.
- `shim-bin.js` tracks and creates `ozy`, `ozy.cmd`, and `ozy.ps1`.
- `cmd-shim` writes all three files.

Expected directory structure:

```text
project/
  node_modules/
    .bin/
      ozy
      ozy.cmd
      ozy.ps1
    @scope/
      tool/
        package.json
        bin/
          ozy
```

Important npm top-package detail: npm `bin-links` returns without linking bins
for a non-global top package. That is about the project root package itself, not
about a package installed into `node_modules` as a dependency.

### npm, global install on Windows

Observed from source:

- `bin-links/lib/index.js` states that global top packages on Windows get bins
  installed in `{prefix}`.
- `bin-target.js` returns `getPrefix(path)` for Windows global top packages.
- The package payload lives under `{prefix}/node_modules`.

Expected directory structure:

```text
<npm-prefix>/
  ozy
  ozy.cmd
  ozy.ps1
  node_modules/
    @scope/
      tool/
        package.json
        bin/
          ozy
```

Fixture verification still needed: exact `<npm-prefix>` for current npm on
Windows with `npm prefix -g`, and shell precedence when `ozy.exe` is later added
beside these shims.

### pnpm, local dependency install on Windows

Observed from source:

- `@pnpm/link-bins` reads dependency manifests and links bins into the provided
  bins directory.
- On Windows, before writing shims it removes an existing `ozy.exe` from the bin
  directory.
- It calls `@zkochan/cmd-shim`.
- For normal packages, `makePowerShellShim` is true on Windows unless the
  package being linked is named `pnpm`.

Expected directory structure:

```text
project/
  node_modules/
    .bin/
      ozy
      ozy.cmd
      ozy.ps1
    @scope/
      tool -> .pnpm/@scope+tool@1.2.3/node_modules/@scope/tool
    .pnpm/
      @scope+tool@1.2.3/
        node_modules/
          @scope/
            tool/
              package.json
              bin/
                ozy
```

pnpm-specific warning: because `@pnpm/link-bins` removes `ozy.exe` when linking
on Windows, a self-repair strategy that creates `node_modules/.bin/ozy.exe`
could be undone by a later `pnpm install`.

### pnpm, global install on Windows

Expected shape, but must be verified with a fixture:

```text
<PNPM_HOME>/
  ozy
  ozy.cmd
  ozy.ps1
<pnpm-global-store-or-virtual-store>/
  ...
```

The source inspected here proves the shim writer and local bin behavior. It does
not by itself prove the exact current global directory layout for every pnpm
configuration.

### Bun, local dependency install on Windows

Observed from source:

- Bun uses a POSIX symlink path on non-Windows and `create_windows_shim` on
  Windows.
- Windows `create_windows_shim` writes adjacent `ozy.bunx` metadata and
  `ozy.exe`.
- The `.bunx` metadata stores the relative target and launcher information.
- The PE `ozy.exe` reads its adjacent `.bunx` metadata.

Expected directory structure:

```text
project/
  node_modules/
    .bin/
      ozy.bunx
      ozy.exe
    @scope/
      tool/
        package.json
        bin/
          ozy
```

Bun does not use npm-style `ozy.cmd` and `ozy.ps1` shims for package bins in the
source inspected here.

### Bun, global install on Windows

Expected shape, but must be verified with a fixture:

```text
<bun-global-bin>/
  ozy.bunx
  ozy.exe
<bun-global-package-location>/
  @scope/
    tool/
      package.json
      bin/
        ozy
```

The source proves the pair of files Bun writes for a Windows bin destination.
The exact global install root should be recorded from a real `bun add -g`
fixture.

### Yarn Classic, local dependency install on Windows

Observed from source:

- `src/package-linker.js` calls `@zkochan/cmd-shim` on Windows.
- It passes `createPwshFile: false`.
- It links into `targetBinLoc/.bin`.

Expected directory structure:

```text
project/
  node_modules/
    .bin/
      ozy
      ozy.cmd
    @scope/
      tool/
        package.json
        bin/
          ozy
```

No `ozy.ps1` is expected from Yarn Classic because it disables PowerShell shim
creation.

### Yarn Classic, global install on Windows

Expected shape, but must be verified with a fixture:

```text
<yarn-classic-global-bin>/
  ozy
  ozy.cmd
<yarn-classic-global-package-location>/
  ...
```

The source proves shim type and local `.bin` behavior. The exact global path
depends on Yarn Classic configuration and needs Windows fixture capture.

### Yarn Berry with `nodeLinker: node-modules` on Windows

Observed from source:

- The node-modules linker reads manifests and builds a `binSymlinks` map.
- On Windows it calls `@zkochan/cmd-shim` with `createPwshFile: false`.
- It removes outdated `name` and `name.cmd`; it does not remove `name.ps1` in
  the inspected code path because it does not create one.

Expected directory structure:

```text
project/
  node_modules/
    .bin/
      ozy
      ozy.cmd
    @scope/
      tool/
        package.json
        bin/
          ozy
```

No persistent `ozy.ps1` is expected from this path.

### Yarn Berry with default PnP on Windows

Observed from source:

- PnP does not create the normal persistent `node_modules/.bin` tree.
- `scriptUtils.makePathWrapper` creates temporary wrappers in a Yarn-managed
  `binFolder` for script execution.
- On Windows, `makePathWrapper` creates `name.cmd`.
- It also creates a no-extension POSIX shell wrapper.
- It does not create `name.ps1` in the inspected code.
- `installBinaries` decides whether to invoke a target through Node or directly
  by calling `isNodeScript`.

Expected script-time shape:

```text
<temporary-yarn-bin-folder>/
  ozy
  ozy.cmd
```

There may be no stable file path for a self-repairing command to mutate when
the command is only available through `yarn run` in PnP mode. That is a major
constraint.

### Yarn Berry `dlx` on Windows

Observed from source:

- `plugin-dlx` creates a temporary project directory.
- It writes a temporary `package.json`, `yarn.lock`, and `.yarnrc.yml`.
- It runs `yarn add --fixed -- ...` in that temporary project.
- It loads the temporary project install state.
- It executes the command through `scriptUtils.executeWorkspaceAccessibleBinary`.

Expected shape:

```text
<temporary-base>/
  dlx-<pid>/
    package.json
    yarn.lock
    .yarnrc.yml
    .pnp.cjs or node_modules/       # depends on effective Yarn config
```

Then command execution follows the same `scriptUtils` temporary wrapper behavior
described in the PnP section. `dlx` is not a durable global command install
surface; it is a temporary execution surface.

## Literal shim contents

These examples use this package layout:

```text
project/
  node_modules/
    .bin/
      ozy
      ozy.cmd
      ozy.ps1
    @scope/
      tool/
        bin/
          ozy
```

and this bin target:

```javascript
#!/usr/bin/env node
console.log(process.argv)
```

The exact absolute paths vary by install location. The examples below keep the
same relative relationship the package managers generate.

Markdown renders the `.cmd` examples with normal line breaks. The generated
`.cmd` files are Windows command scripts and should be treated as CRLF-oriented
text files when comparing raw bytes.

### npm `cmd-shim`: `ozy`

npm's no-extension shim is a POSIX shell script for Git Bash/MSYS/Cygwin-style
execution.

```sh
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
basedir_win="$basedir"

case `uname -a` in
  *CYGWIN*|*MINGW*|*MSYS*)
    if command -v cygpath > /dev/null 2>&1; then
      basedir_win=`cygpath -w "$basedir"`
    fi
  ;;
  *WSL2*)
    if command -v wslpath > /dev/null 2>&1; then
      basedir_win="$(wslpath -w "$basedir" 2> /dev/null)"
      if [ $? -ne 0 ] || [ -z "$basedir_win" ]; then
        echo "Error: wslpath failed to convert path. WSL environment may be misconfigured." >&2
        exit 1
      fi
    fi
  ;;
esac

PROG_EXE="$basedir/node.exe"
if ! [ -x "$PROG_EXE" ]; then
  PROG_EXE="$basedir/node"
  if ! [ -x "$PROG_EXE" ]; then
    PROG_EXE=node
    if ! [ -x "$PROG_EXE" ]; then
      PROG_EXE=node.exe
    fi
  fi
fi

exec "$PROG_EXE"  "$basedir_win/../@scope/tool/bin/ozy" "$@"
```

### npm `cmd-shim`: `ozy.cmd`

```bat
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\..\@scope\tool\bin\ozy" %*
```

### npm `cmd-shim`: `ozy.ps1`

```powershell
#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/../@scope/tool/bin/ozy" $args
  } else {
    & "$basedir/node$exe"  "$basedir/../@scope/tool/bin/ozy" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/../@scope/tool/bin/ozy" $args
  } else {
    & "node$exe"  "$basedir/../@scope/tool/bin/ozy" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
```

### pnpm `@zkochan/cmd-shim`: `ozy`

pnpm uses `@zkochan/cmd-shim`. Yarn Classic and Yarn Berry node-modules use the
same shim generator, but pass `createPwshFile: false`.

```sh
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
basedir_win="$basedir"
exe=""
msys=""

case `uname -a` in
  *CYGWIN*|*MINGW*|*MSYS*)
    if command -v cygpath > /dev/null 2>&1; then
      basedir_win=`cygpath -w "$basedir"`
    fi
    exe=".exe"
    msys="true"
  ;;
  *WSL2*)
    if command -v wslpath > /dev/null 2>&1; then
      basedir_win="$(wslpath -w "$basedir" 2> /dev/null)"
      if [ $? -ne 0 ] || [ -z "$basedir_win" ]; then
        basedir_win="$basedir"
      else
        exe=".exe"
      fi
    fi
  ;;
esac

if [ -n "$exe" ] && [ -x "$basedir/node.exe" ]; then
  exec "$basedir/node.exe"  "$basedir_win/../@scope/tool/bin/ozy" "$@"
elif [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/../@scope/tool/bin/ozy" "$@"
elif command -v node >/dev/null 2>&1; then
  exec node  "$basedir/../@scope/tool/bin/ozy" "$@"
elif [ -n "$exe" ] && command -v node.exe >/dev/null 2>&1; then
  exec node.exe  "$basedir_win/../@scope/tool/bin/ozy" "$@"
else
  exec node  "$basedir/../@scope/tool/bin/ozy" "$@"
fi
# cmd-shim-target=<absolute path to project/node_modules/@scope/tool/bin/ozy>
```

### pnpm `@zkochan/cmd-shim`: `ozy.cmd`

```bat
@SETLOCAL
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\..\@scope\tool\bin\ozy" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\..\@scope\tool\bin\ozy" %*
)
```

### pnpm `@zkochan/cmd-shim`: `ozy.ps1`

```powershell
#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/../@scope/tool/bin/ozy" $args
  } else {
    & "$basedir/node$exe"  "$basedir/../@scope/tool/bin/ozy" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/../@scope/tool/bin/ozy" $args
  } else {
    & "node$exe"  "$basedir/../@scope/tool/bin/ozy" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
```

### Yarn Classic and Yarn Berry node-modules

Yarn Classic and Yarn Berry node-modules emit the `@zkochan/cmd-shim` `ozy` and
`ozy.cmd` contents shown above. They do not emit `ozy.ps1` in the inspected
source paths because both pass `createPwshFile: false`.

### Yarn Berry PnP/script wrappers: `ozy`

Yarn Berry PnP does not create persistent `node_modules/.bin` shims. For
script-time execution, `scriptUtils.makePathWrapper` creates a temporary
no-extension shell wrapper:

```sh
#!/bin/sh
exec "<argv0>" '<arg0>' '<arg1>' "$@"
```

For a JS package binary, Yarn passes Node as `argv0` and the package binary path
as an argument, so the shape is:

```sh
#!/bin/sh
exec "<path-to-node>" '<path-to-package-bin-ozy>' "$@"
```

For a native binary, Yarn passes the binary path as `argv0` with no package-bin
argument:

```sh
#!/bin/sh
exec "<path-to-native-binary>"  "$@"
```

### Yarn Berry PnP/script wrappers: `ozy.cmd`

Yarn Berry's temporary CMD wrapper is one line:

```bat
@goto #_undefined_# 2>NUL || @title %COMSPEC% & @setlocal & @"<argv0>" "<arg0>" "<arg1>" %*
```

For a JS package binary:

```bat
@goto #_undefined_# 2>NUL || @title %COMSPEC% & @setlocal & @"<path-to-node>" "<path-to-package-bin-ozy>" %*
```

For a native binary:

```bat
@goto #_undefined_# 2>NUL || @title %COMSPEC% & @setlocal & @"<path-to-native-binary>"  %*
```

Yarn Berry's `makePathWrapper` does not create a `.ps1` file.

### Bun package manager: `ozy.exe`

Bun's Windows command shim is not a text shim. It writes:

```text
ozy.exe   # copied PE executable bytes from bun_shim_impl.exe
ozy.bunx  # target-specific binary metadata read by ozy.exe
```

`ozy.exe` is target-independent PE content embedded in Bun. Its file starts with
the normal DOS/PE magic bytes:

```text
4d 5a ...  # "MZ"
```

The target-specific content lives in `ozy.bunx`.

### Bun package manager: `ozy.bunx`

The `.bunx` file is binary metadata, not text. Bun's source documents and
encodes it as:

```text
[UTF-16LE bin_path][u16 quote][u16 zero](shebang?)[flags:u16]

if shebang:
[UTF-16LE launcher][u16 space][u32 bin_path_byte_len][u32 launcher_plus_space_byte_len]
```

The flags are a little-endian `u16` bitfield:

```text
bit 0: launcher is node or bun
bit 1: launcher is node
bit 2: has shebang
bits 3..15: version tag, currently 5478
```

For `node_modules/.bin/ozy` pointing at `node_modules/@scope/tool/bin/ozy`, Bun
stores the target path relative to `node_modules`, after stripping the leading
`..\` from the `.bin` relative path:

```text
@scope\tool\bin\ozy
```

For a target whose first line is `#!/usr/bin/env node`, the concrete `.bunx`
bytes are:

```text
00000000  40 00 73 00 63 00 6f 00 70 00 65 00 5c 00 74 00  @.s.c.o.p.e.\.t.
00000010  6f 00 6f 00 6c 00 5c 00 62 00 69 00 6e 00 5c 00  o.o.l.\.b.i.n.\.
00000020  6f 00 7a 00 79 00 22 00 00 00 6e 00 6f 00 64 00  o.z.y."...n.o.d.
00000030  65 00 20 00 26 00 00 00 0a 00 00 00 37 ab        e. .&.......7.
```

Decoded:

```text
bin_path: @scope\tool\bin\ozy
quote terminator: u16 0x0022
nul terminator: u16 0x0000
launcher: node
space: u16 0x0020
bin_path_byte_len: 0x00000026
launcher_plus_space_byte_len: 0x0000000a
flags: 0xab37
```

`0xab37` means:

```text
version tag: 5478
has shebang: true
launcher is node: true
launcher is node or bun: true
```

## Target invocation rules

### npm `cmd-shim`

For a Windows bin target, npm's `cmd-shim`:

- Reads the target file.
- Parses a shebang from the first line when one exists.
- If a shebang exists, the generated shim runs that program and passes the
  target path as an argument.
- If no shebang exists, the generated shim calls the target path directly.
- Writes `name`, `name.cmd`, and `name.ps1`.

Implication: if `./bin/ozy` starts with `#!/usr/bin/env node`, npm's `.cmd` and
`.ps1` shims invoke Node and run `bin/ozy`; they do not execute `bin/ozy` as a
PowerShell file just because a `.ps1` shim exists.

### pnpm and Yarn `@zkochan/cmd-shim`

For a Windows bin target, `@zkochan/cmd-shim`:

- Creates a no-extension shell shim.
- Creates `name.cmd` when `createCmdFile` is enabled.
- Creates `name.ps1` only when `createPwshFile` is enabled.
- Uses shebang parsing and extension fallback.
- Extension fallback maps `.js`, `.cjs`, `.mjs` to Node, `.cmd` and `.bat` to
  CMD, `.ps1` to PowerShell, and `.sh` to sh in the inspected package version.

Implications:

- pnpm normally creates `name`, `name.cmd`, and `name.ps1`.
- Yarn Classic creates `name` and `name.cmd`.
- Yarn Berry node-modules creates `name` and `name.cmd`.

### Bun Windows PE shim

For a Windows bin target, Bun:

- Writes `name.exe`.
- Writes `name.bunx`.
- Encodes the target path and launcher into `.bunx`.
- Uses a shebang when it can parse one.
- If there is no shebang, extension fallback maps JS/TS-like extensions and
  `.sh` to `bun run`, `.cmd`/`.bat` to `cmd /c`, and `.ps1` to
  `powershell -ExecutionPolicy Bypass -File`.
- If the target has no recognized extension and no shebang, the PE shim runs the
  target path directly.

## What happens if the target itself is `.cmd`, `.bat`, `.ps1`, or `.exe`

This section is about `package.json#bin` pointing at different target files:

```json
{
  "bin": {
    "ozy": "./bin/ozy.cmd"
  }
}
```

or:

```json
{
  "bin": {
    "ozy": "./bin/ozy.exe"
  }
}
```

Package manager behavior is not "link target as-is" on Windows, except for Bun's
PE shim strategy. npm, pnpm, and Yarn generally create manager-owned shims that
then invoke the target.

Expected effects from source:

| Target path | npm `cmd-shim` | pnpm/Yarn `@zkochan/cmd-shim` | Bun |
| --- | --- | --- | --- |
| `./bin/ozy` with shebang | Generated shim invokes shebang program | Generated shim invokes shebang program | `.exe` shim uses parsed shebang |
| `./bin/ozy` without shebang | Generated shim invokes target path directly | Generated shim likely invokes target path directly | `.exe` shim invokes target path directly |
| `./bin/ozy.js` | Shebang if present, otherwise direct target path | Node by extension fallback if no shebang | `bun run` by extension fallback if no shebang |
| `./bin/ozy.cmd` | Shebang if present, otherwise direct target path | `cmd` by extension fallback if no shebang | `cmd /c` by extension fallback if no shebang |
| `./bin/ozy.bat` | Shebang if present, otherwise direct target path | `cmd` by extension fallback if no shebang | `cmd /c` by extension fallback if no shebang |
| `./bin/ozy.ps1` | Shebang if present, otherwise direct target path | PowerShell by extension fallback if no shebang | PowerShell by extension fallback if no shebang |
| `./bin/ozy.exe` | Shebang read fails or no shebang, then direct target path | Direct target path when treated as native executable | Direct target path via PE shim metadata |

The `.ps1` case is easy to misunderstand. This file is valid PowerShell:

```powershell
#!/usr/bin/env node
node install.js
```

because `#` begins a comment in PowerShell. But if a package manager reads that
file as a bin target and honors the shebang, the generated shim may run it with
Node instead of PowerShell. That means a polyglot `.ps1` target does not
guarantee PowerShell execution.

Replacing a `.ps1` file with PE executable bytes is not a safe second-run
strategy. PowerShell treats `.ps1` as a script path. A PE file with a `.ps1`
extension will be parsed as script text and fail.

## Same-name `.exe` beside text shims

One possible Windows repair strategy is:

```text
node_modules/.bin/
  ozy
  ozy.cmd
  ozy.ps1
  ozy.exe       # added by self-repair
```

This might make `ozy` resolve to `ozy.exe` in `cmd.exe` because common `PATHEXT`
orders `.EXE` before `.BAT` and `.CMD`. It is not yet proven for:

- PowerShell command resolution.
- Git Bash/MSYS.
- npm global installs.
- pnpm local/global installs, especially because pnpm removes existing
  `name.exe` before relinking bins.
- Yarn Classic and Yarn Berry without a `.ps1` shim.
- Bun, which already creates `name.exe`.
- uninstall cleanup.

Do not rely on this strategy without the fixture matrix below.

## Why shim discovery is hard

The installer JS can inspect:

- `process.argv[0]`
- `process.argv[1]`
- `process.execPath`
- `process.env.npm_execpath`
- `process.env.npm_config_user_agent`
- parent process information, if available

Those values do not uniformly identify the package-manager-created shim file.
Depending on manager and shell, the current process may be:

- `node.exe` running a target script selected by a text shim.
- `powershell.exe` running a `.ps1` shim.
- `cmd.exe` running a `.cmd` shim.
- Bun's PE shim running through `.bunx` metadata.
- Yarn Berry running through a temporary wrapper directory.

Caller-tree inspection can help debugging, but it is not a stable installer API.
It also does not tell us what files the package manager considers owned for
uninstall. For a repair strategy, file ownership matters as much as locating the
file.

## Current conclusions

1. The base package needs to own the command `bin` entries. Platform-package
   `bin` entries alone are not enough for a generic local/global install story.
2. POSIX can be clean: a first-run JS launcher replaces the package-owned
   command file with a hardlink or copy of the platform `multi-call-binary`,
   then executes that command path.
3. Windows is not one case:
   - npm writes `name`, `name.cmd`, and `name.ps1`.
   - pnpm normally writes `name`, `name.cmd`, and `name.ps1`, and removes a
     pre-existing `name.exe` while linking.
   - Bun writes `name.exe` and `name.bunx`.
   - Yarn Classic writes `name` and `name.cmd`.
   - Yarn Berry node-modules writes `name` and `name.cmd`.
   - Yarn Berry PnP uses temporary script wrappers rather than persistent
     `node_modules/.bin` files.
4. Replacing `.cmd` or `.ps1` with PE executable bytes is not a general
   solution. `.cmd` and `.ps1` are interpreted as text by their shells.
5. Windows keeps the package-manager shim and JS launcher, but the launcher
   creates and runs a command-named `.exe` next to itself. This avoids locating
   or mutating package-manager-owned shims while still giving the multi-call
   executable a command-specific invocation name.

## Required Windows fixture matrix

Create a small package with one command and repeat with these target variants:

```text
bin/ozy              # JS with #!/usr/bin/env node
bin/ozy-no-shebang   # JS without shebang
bin/ozy.cmd
bin/ozy.bat
bin/ozy.ps1
bin/ozy.exe
```

For each package manager:

- npm
- pnpm
- bun
- Yarn Classic
- Yarn Berry with PnP
- Yarn Berry with `nodeLinker: node-modules`

Test install modes:

- local dependency install
- global install
- Yarn Berry `dlx` temporary install

Test shells:

- `cmd.exe`
- PowerShell 5 if available
- PowerShell 7
- Git Bash/MSYS if installed

Record:

```text
manager:
install mode:
shell:
target variant:
created files:
Get-Command ozy -All:
where.exe ozy:
command executed:
process.argv:
process.execPath:
process.cwd:
npm_execpath:
npm_config_user_agent:
after adding ozy.exe beside shims, command executed:
after uninstall, leftover files:
```

Do not implement the Windows shim mutation logic until this matrix is filled in
for the package managers we intend to support.
