- Set up any git repo to use a passkey-based SSH key. 
  Auto registers SSH authn and signing keys with github.
- Auto provision npm packages and set up trusted publishing. Precursor to jive.sh tool

## Development

- `bun run build` creates the full publishable package set.
- `bun run build:local` uses `--local-only` to build the base package and only the current platform package for local verification.

## Follow-up investigations

- Verify Windows package-manager behavior when an entrypoint command name includes literal `.exe` text, including names that already end with `.exe` such as `src/entrypoints/foo.exe.ts`.
- Define how the build should handle source files that import runtime assets or modules outside `src`.

## Signing agent architecture

### Security invariant (load-bearing)

Private keys NEVER leave the agent process. All signing happens inside the agent. Any solution that returns a private key to the CLI is invalid regardless of whether it fixes a technical symptom.

### Module split

- `common-modules` (`CommonModules` enum): shared between CLI and agent. Currently: `OSPlatform`.
- `cli-modules` (`Modules` enum): CLI-only. Currently: `Git`, `GitHub`, `AgentClient`.
- `agent-modules` (`AgentModules` enum): agent-only. Currently: `SSHAgent`, `Session`.

### Agent module interfaces (all methods return `EffectGen`)

**`ISession`** (`src/modules/session/interface.ts`)
- `declareSession(context: SessionContext): EffectGen<DeclaredSessionResult, SessionError>` — triggers PRF browser flow, derives signing+deploy keys, stores deploy key in-memory, writes pubkey→credentialId to the credential map file on disk.
- `sign({ pubkeyWire, dataToSign, context }): EffectGen<Buffer, SessionError>` — signs using the active session keyed by pubkey; consumes (deletes) the in-memory entry after use.
- `listPubkeys(): EffectGen<string[], never>` — reads the credential map file, returns all known deploy pubkeys as OpenSSH strings.

**`ISSHAgent`** (`src/modules/ssh-agent/interface.ts`)
- `handleExtension(data): EffectGen<Buffer, never>`
- `handleRequestIdentities(): EffectGen<Buffer, never>` — calls `session.listPubkeys()`
- `handleSignRequest(data): EffectGen<Buffer, never>` — parses wire format, calls `session.sign(...)`

Key files: `src/modules/session/impl.ts` (`SessionImpl` — PRF browser flow, in-memory session store, credential map R/W), `src/modules/session/generate-ssh-keypair.ts` (Ed25519 key derivation from seed via HKDF), `src/modules/session/passkey-prf-page.ts` (WebAuthn PRF browser flow page), `src/modules/ssh-agent/impl.ts` (`SSHAgentImpl` — dispatch only, delegates to session module), `src/commands/git/passkey-to-ssh/agent/ssh-agent-server.ts` (Unix socket server dispatching to `SSHAgent` methods), `src/commands/git/passkey-to-ssh/agent/group.ts` (RPC group: `GetVersion` + `DeclareSession`), `src/commands/git/passkey-to-ssh/agent/handlers.ts` (RPC handlers), `src/entrypoints/ozy-signing-agent.ts` (agent entrypoint layer wiring).

### Context derivation at sign time

The SSH agent derives repo context by looking up the **peer PID** of the Unix socket connection (`SO_PEERCRED` on Linux, `LOCAL_PEERCRED`/`getpeereid` on macOS, `GetNamedPipeClientProcessId` on Windows). From the PID, the agent reads the process's cwd, then reads `remote.origin.url` from that repo's git config to identify the repo.

- Commit signing: peer PID → cwd → repo path → remote URL.
- Push/pull: repo already known from the deploy key; PID provides corroborating verification.
- Action type is determinable from which key is used — signing key = commit, deploy key = push/pull.

This avoids filesystem walks (slow, breaks on network mounts) and is resilient to users moving their repo around the filesystem.

### Credential map file

`AGENT_CREDENTIAL_MAP_PATH` = `{CLI_DIR}/ozy-signing-agent-credentials.json`, format `Record<string, string>` mapping an OpenSSH deploy pubkey (`ssh-ed25519 <base64>`) to a base58 credentialId. Used to (1) pre-select an existing passkey credential ID in the WebAuthn PRF flow, avoiding a new passkey per session, and (2) answer `REQUEST_IDENTITIES` from the SSH client.

### SSH agent protocol constants

`27` = EXTENSION, `11` = REQUEST_IDENTITIES, `13` = SIGN_REQUEST, `12` = IDENTITIES_ANSWER, `14` = SIGN_RESPONSE, `5` = FAILURE.

### OSPlatform socket server

`startSocketServer(path, onData: (Buffer) => Promise<Buffer>)` — async callback; Bun uses an `async data(socket, data)` handler on Unix, Windows uses a named pipe.

### Layer composition

Use explicit `Layer.provide` to compose self-contained layers — `Layer.provideMerge` chaining does not propagate transitive deps correctly for this use case:

```typescript
const sessionLayer = SessionImpl.Layer.pipe(Layer.provide(OSPlatformImpl.Layer));
const sshAgentLayer = SSHAgentImpl.Layer.pipe(Layer.provide(sessionLayer));
// Then provide the merged set to consumers
```

### Known gap: agent lifecycle is hand-rolled, no auto-restart at sign time

`agent-client/impl.ts` has `ensureRunning()`/`startAgent()`/`killIfRunning()`, but these are only invoked from `commands/git/setup.ts` (one-time setup). The commit-signing path (`ozy-ssh-keygen` entrypoint) is a dumb wrapper that sets `SSH_AUTH_SOCK` and execs the real `ssh-keygen` — it never checks if the agent is alive. If the agent process dies after setup, every subsequent `git commit` fails with "No private key found for public key ..." and nothing restarts it.

Future direction: replace this hand-rolled PID-file/ping/kill lifecycle with real OS process supervision — `launchd` (macOS), `systemd --user` (Linux), Windows Services/Scheduled Tasks. Longer-term, a jive library template convention where anything under `agent-entrypoints/` gets registered with the OS-level supervisor instead of just being dropped on `PATH`, so lifecycle management is the template's job once rather than something every agent-shaped CLI reimplements.

### Pending work

- Parse `context` from `dataToSign` in `SSHAgentImpl.handleSignRequest` (TODO) — enables on-the-fly PRF flows when no session is pre-declared.
- Git clone end-to-end test with the session module in place.

### Distribution: `optionalDependencies`, not a `bun` runtime dependency

Decided (not yet implemented): distribute per-platform via `optionalDependencies`, the same pattern Bun's own npm package uses for itself — a meta package with no `os`/`cpu` restriction lists every platform variant as `optionalDependencies`; each platform sub-package declares its own `os`/`cpu` fields; npm/yarn/pnpm skip installing any optionalDependency whose `os`/`cpu` doesn't match the current machine. For ozy-cli: `@ozyman42/ozy-cli` (meta) lists `-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64`, `-windows-x64` variants as `optionalDependencies`, each containing the same `Bun.build({compile})` standalone binaries built today. The meta package's `bin` entry becomes a small dispatcher using `require.resolve()` to find whichever platform sub-package landed, then `spawnSync`s its binary directly — no fetch, no tar parsing, no custom registry-URL construction. This replaces the current `generateLauncher`/base-package mechanism (a Node script that fetches the platform tarball from the registry and extracts it with a hand-written gunzip+tar parser on first run).

Rejected alternative: depend on `bun` as a regular dependency and ship plain bundled JS instead of compiled binaries. Rejected because: (1) whether `bun`'s own `optionalDependencies` resolve correctly for a *globally* installed package specifically is unverified and global installs have a history of different hoisting behavior across npm/yarn/pnpm; (2) Bun version drift across user machines, vs. compiled binaries baking in a specific deterministic Bun version; (3) a Node-executed dispatcher spawning a locally-installed `bun` binary leaves the parent `node` process alive for the full invocation — no clean single-process handoff, and a relative shebang path doesn't help since it resolves relative to the caller's cwd, not the script's location; (4) sacrifices "compiled binary is a single portable file you can copy anywhere."
