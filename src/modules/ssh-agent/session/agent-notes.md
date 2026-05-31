# Why This Tool Exists

`webauthn-sk-ecdsa-sha2-nistp256@openssh.com` is the SSH key type that would allow platform passkeys (Face ID, Touch ID, Windows Hello) to sign SSH auth and commits directly — no PRF, no HKDF, no agent needed. If GitHub supported it, this tool would be largely unnecessary for the basic case.

GitHub only supports the `sk-` prefix variants (FIDO2 hardware security keys like YubiKey), not the `webauthn-sk-` platform passkey variant. So we need the PRF → HKDF → derived key path instead.

Even if GitHub added `webauthn-sk-` support, per-repo scoping would remain valuable: a standard GitHub SSH key grants access to all your repos. Deploy keys + per-repo HKDF derivation is the only way to get true repo-level auth scoping, critical for the Jive multi-repo context.

## Long-Term Vision (not current scope)

Jive could eventually bypass SSH entirely: accept native passkey WebAuthn signatures directly, with the challenge encoding the repo (for push/pull) or the commit SHA (for signing). Jive verifies server-side and writes to the repo via its GitHub App permissions. No SSH agent, no key derivation, no deploy keys — passkey IS the auth primitive.

---

# Key Architecture: Per-Repo HKDF Derivation

Each repo gets a distinct SSH keypair derived from the passkey PRF seed:
- `HKDF(passkey_seed, repo_url)` → SSH private key for that repo
- Public key is registered as a GitHub **deploy key** on that specific repo
- Agent maintains a persistent registry: `pubkey → repo_path` (populated at setup time)

**Security property:** A signature from repo X's derived key is valid ONLY for repo X's deploy key. Even a sophisticated attacker who gets the agent to sign for repo X's key cannot use that signature to access repo Y. The per-repo key derivation IS the security boundary — no binary replacement or cwd trick escapes it.

**Signing request flow:**
1. Request arrives with pubkey P + data to sign
2. Agent looks up registry: pubkey P → repo R
3. Agent triggers WebAuthn PRF to get seed (if not cached)
4. HKDF(seed, R) → private key K; verify K's pubkey = P
5. Sign and return

**Session manifest:** list of `(pubkey, operation_type, count)` tuples. Incoming requests match by pubkey — unambiguous, one pubkey per repo. No cwd lookup needed.

**Full security stack against a sophisticated local attacker:**
- Push/pull auth: scoped to specific repo via deploy key — signature for repo X is cryptographically useless for repo Y
- Commit signing: separate WebAuthn tap, browser shows exact commit content being signed — attacker can't forge a signed commit without the user seeing it
- Verified commits enforced server-side: repo rejects unsigned/unverified commits

An attacker would need to both obtain an auth signature AND trick the user into approving a commit signing request for malicious content — both visible in the browser. Very hard to pull off silently at any scale.

---

# Setup Flow (per repo)

`ozy git passkey-to-ssh setup`:
1. If no derived pubkey registered for this repo:
   - Trigger WebAuthn PRF to get seed (registration assertion, creates passkey if needed)
   - HKDF(seed, repo_url) → keypair
   - Browser OAuth flow to get short-lived GitHub token (admin:repo scope, setup only, discarded after)
   - Register pubkey as deploy key via GitHub API (`POST /repos/{owner}/{repo}/keys`)
   - Store pubkey → repo_path in local agent registry
   - Write pubkey to local git config (`user.signingkey`)
   - Write git config settings (sshCommand, gpg.format, gpg.ssh.program)
2. If pubkey already registered → authentication flow (start agent/session)

---

# Git Config (per-repo local)

```
# 1. Network Authn (Pushes/Pulls)
git config local.core.sshCommand "env SSH_AUTH_SOCK='/path/to/your/custom/agent.sock' ssh"

# 2. Tell Git to use SSH format for signing
git config local.gpg.format "ssh"

# 3. Provide the literal public key (Triggers agent mode automatically)
git config local.user.signingkey "ssh-ed25519 AAAAC3Nz..."

# 4. Force ssh-keygen to read your custom agent using OpenSSH options
git config local.gpg.ssh.program "ssh-keygen -o IdentityAgent=/path/to/your/custom/agent.sock"
```

Both auth and signing flow through the same custom SSH agent socket.
Pubkey lives in local git config (`user.signingkey`).

---

# Browser / Agent Communication

- Agent starts a localhost HTTP server on a random port
- Agent opens browser to `http://localhost:<port>/`
- Page performs WebAuthn PRF assertion
- Page encrypts PRF seed with agent's ephemeral public key
- Page `fetch()` POSTs encrypted seed to `POST /seed` on same server
- Agent responds with success or failure JSON
- On success, page instructs user to close the tab
- Agent tears down HTTP server, derives SSH key via HKDF from decrypted seed

---

# Agent Ephemeral Keypair

- Generated fresh on each invocation of `getAndVerifySigningAndDeployKey` (never touches disk)
- Used only to encrypt the PRF seed during browser→agent transfer
- Wiped after session ends along with derived SSH key
- ECDH P-256 + HKDF → AES-GCM (X25519 not supported in Bun compiled binaries)

**Security properties of the ephemeral keypair:**

- **Prevents PRF sniffing:** An attacker who intercepts the encrypted POST to `/seed` cannot recover the raw PRF seed. The ciphertext is decryptable only by the agent that generated the keypair for that session.
- **Prevents cross-session replay:** The AES-GCM key is derived from `ECDH(agent_private, browser_ephemeral_public)`. A new invocation generates a fresh agent keypair, so the ECDH shared secret differs — replaying a captured encrypted POST to a new server produces a different AES key and decryption fails with an authentication tag mismatch. The encrypted seed is cryptographically bound to the specific agent public key that was live during that session.

---

# Session Model

Sessions are **explicitly pre-declared** by the orchestrator (e.g. jive), not accumulated dynamically.

Flow:
1. Orchestrator starts a session, declaring the full manifest of expected operations upfront
2. Agent opens browser; browser shows exactly what will be signed
3. User approves with a single tap
4. Agent derives SSH key, services only the declared requests
5. Any request outside the declared manifest is rejected outright
6. After all declared requests are serviced (or on cancel), key is wiped and session ends

**Why not timeout-based accumulation:** A malicious script with shell access could inject additional signing requests into an open session window. With pre-declaration, the agent has a fixed allowlist.

**Unrecognized requests:** If a signing request arrives that doesn't match any active session's manifest, the agent treats it as a single-request session and initiates its own WebAuthn flow for just that one signature. This handles:
- Direct git usage (no orchestrator started a session)
- Malicious injection (user sees a single isolated request in the browser and can deny it)

## What Can Be Pre-Declared?

For **SSH auth (push/pull)**: the challenge bytes are random and server-generated — the exact signature input isn't known in advance. Can only pre-declare: destination host + operation type (push vs pull) + repo path. Agent enforces that only declared host/repo/operation combinations are serviced, up to declared counts.

**SSH auth request identifiability:** For N repos all pointing at the same SSH host (e.g. github.com), the agent sees N signing requests that are effectively indistinguishable — each is "sign this opaque blob as user `git`". The repo path is not part of SSH auth signing data; it only appears later in the git protocol layer after authentication. The session identifier is a fresh hash per connection (different ephemeral keys), so blobs differ, but their meaning is the same from the agent's perspective.

Implication: manifest matching for SSH auth is host + username + operation type + **count**. The agent allows exactly N such requests and rejects any beyond that. Individual slot-to-repo mapping is not enforceable at the agent level.

---

# Registration vs Authentication Flow

`ozy git passkey-to-ssh setup` (per repo):
- If no pubkey in local git config → **registration flow**: create passkey, derive SSH key, store pubkey in git config, configure git settings above
- If pubkey exists → **authentication flow**: start agent if not running, either use cached key or open browser for PRF assertion

---

# Context Derivation at Sign Time

The agent derives repo context by reading the **peer PID** of the Unix socket / named pipe connection — not from the signing data itself, and not via filesystem walk.

**Why not parse the signing data:**
- Commit signing: the SSHSIG blob contains `SHA-512(commit object)`. The commit object has tree hash, parent hashes, author, committer, message — but NOT the repo name. The final commit hash also isn't present (it depends on the signature, so it doesn't exist yet).
- Push/pull SSH auth: the challenge bytes are random and server-generated. Repo path doesn't appear until after authentication at the git protocol layer.

**Why not walk the filesystem:**
- Slow and costly on large filesystems; hangs on network mounts.
- Doesn't handle users moving their repo around.
- Attacker with local filesystem access could plant a git object with the same tree hash into another repo to cause a false match.

**Peer PID approach:**
- The git process that triggered the signing request is alive on the socket. Its cwd IS the repo.
- Get peer PID from the socket connection, read cwd, read `remote.origin.url` from that repo's git config.
- Platform APIs: `SO_PEERCRED` (Linux), `LOCAL_PEERCRED`/`getpeereid` (macOS), `GetNamedPipeClientProcessId` (Windows).

**What each signing key tells you:**
- Deploy key used → push/pull for the repo that key was registered to (per-repo key, unambiguous)
- Signing key used → commit signing; use peer PID to identify which repo's git process is requesting

**What the tree hash means:**
- The tree SHA in a commit is a content-addressed merkle tree over the entire working directory. Signing the commit object is effectively signing that full snapshot plus lineage (parent hashes) and authorship metadata.
- A malicious commit requires a different tree hash (different file contents), so showing the tree hash in the browser prompt is meaningful — but not human-readable. Showing the commit message + author is more practical UX.

---

# Credential Map

The `pubkey → credentialId` map on disk is kept for two reasons:

1. **Pre-selecting an existing passkey in the WebAuthn PRF flow** — avoids creating a new passkey registration on every session; the credential ID is passed to `navigator.credentials.get()` as `allowCredentials`.
2. **Responding to `REQUEST_IDENTITIES` from the SSH client** — `listKeys()` returns all known deploy pubkeys so git knows which keys the agent holds.
---

# Flows mapped out

1. User clones repo (`ozy git setup <owner/repo>`)
  1. Note that in this case, the deploy key needs to be registered before git clone can be run
  1. client calls getOrSetupKeys(credentialId?, repoIds?[])
    1. agent will ask for a new credential if missing. In addition it will derive X deploy keys and 1 signing key
    1. agent will both return these keys and store them in the map from key to credential
  1. client registers deploy keys and signing key if any didn't exist yet
  1. client starts session([Action { user, clone, repo, pubkey }])
    1. agent fails request if the pubkey isn't present in the map file
  1. client calls git clone using the deploy key
    1. ssh agent passes this action to main agent
    1. agent will fail if pubkey mapping isn't present
    1. if there's no matching session, agent will create single use session with just the action
1. User sets up already cloned repo
  1. client calls getOrSetupKeys(credentialId?, repoIds?[])
1. User pushes/pulls
  1. client starts session
1. User signs commit

SSH Agent lists keys by finding the PID talking to it and only returning that key
There can only be one active session at a time. Browser will learn of sneaky attempts to bypass this

---

# Known attack vectors

We use PID hierarchy tied to a session to ensure that only git commands spawned from the trusted PID root can send actions to the active signing session. This works fine on Unix like systems since PID trees are controlled by the kernel, but on Windows someone can set the parent PID to whatever they want and also the PID is not reassigned to some global root when the parent exists.

---

# Open Questions

- For SSH auth pre-declaration: is host+repo+operation granularity sufficient?
