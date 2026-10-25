# Authenticating with npm without the `npm` CLI

`NpmImpl.login()` currently shells out to the `npm login` subprocess and then reads the resulting token
back out of `~/.npmrc`. This document is an investigation, not yet implemented: npm has its own "web
login" handshake that the `npm` CLI itself uses internally, and it can be called directly over HTTP —
the same way `GitHubImpl.authorize` implements GitHub's OAuth flow directly instead of shelling out to
`gh auth login`. `ensureTrustedPublisher`/`setPackageAccessPolicy` already do the equivalent for their
own steps (see below); `login()` and `publish()` are the two remaining places that still spawn `npm`.

## The web-login protocol

1. `POST https://registry.npmjs.org/-/v1/login` — returns `{ doneUrl, loginUrl }`.
2. Open `loginUrl` in the browser (`OSPlatform.openBrowserWindow`, the same call `GitHubImpl.authorize`
   already uses for GitHub's authorize URL). The user completes login — including any 2FA/SSO — entirely
   in the browser.
3. Poll `GET doneUrl`: `202` with a `retry-after` header while the user hasn't finished yet, `200` with
   the token in the response body once they have.
4. Hold the token in memory only, exactly the way `NpmImpl.login()` already treats a token it reads back
   out of `.npmrc` — thread it explicitly through subsequent calls, never persist it.

Compared to the GitHub OAuth flow already implemented in `GitHubImpl.authorize`, this is simpler in two
ways: there's no local callback server to stand up (this is poll-based, not redirect-based), and there's
no OAuth app registration at all — no client ID/secret, unlike GitHub's `JIVE_GITHUB_CLIENT_ID`/`SECRET`.

## Token lifetime and scope (verified via web research 2026-08-18)

- npm fully revoked classic (unlimited-lifetime) tokens registry-wide on December 9, 2025. They no longer
  work at all.
- `npm login` / the web-login flow now issues a **session token**: originally capped at 2 hours, extended
  to **12 hours** as of December 12, 2025 after user pushback — the current standard as of this writing,
  though this area has moved fast and the exact number could change again.
- Still returned and stored the same way classic tokens were (`_authToken` in `.npmrc`, a plain bearer
  token) — not a cookie or a different mechanism. `NpmImpl`'s existing `TOKEN_RE`/`readNpmrc()` extraction
  is unaffected by any of this; only the *acquisition* mechanism would change.
- **Not scoped/granular.** It authenticates as the full account, same permission ceiling as the logged-in
  user — not restricted to specific packages the way an explicitly-created granular access token can be.
  That's actually the right shape for what `publish()` needs, since it has to act on brand-new packages
  that don't exist yet; a pre-scoped granular token couldn't cover that.
- Practical implication: treat any acquired token as short-lived and re-authenticate rather than persist
  or reuse it across long gaps. `NpmImpl.login()` already does this (verify via `whoamiWithToken`, fall
  back to a fresh login if invalid) — that behavior doesn't need to change, only how the fresh login is
  obtained.

## A further step: `publish()` without the CLI too

`ensureTrustedPublisher` and `setPackageAccessPolicy` already bypass the CLI — they POST directly to
`registry.npmjs.org/-/package/<name>/trust` and `/access`. `npm publish` itself is just a `PUT` to the
registry with the tarball as the request body (what the CLI command wraps), so `publish()` has the same
kind of no-CLI path available. This is a separate, independent piece of work from the login flow above —
listed here because it closes out the same "no CLI subprocess at all" goal for the whole module.

## Open questions / not verified against actual source

Everything above came from web research (npm's own docs, `npm/rfcs` discussion #93, and third-party
writeups), not from reading `npm-profile`'s actual source. Before implementing, confirm:

- The exact request body/headers `POST /-/v1/login` expects (whether a nonce is required or optional,
  and what it's used for if so).
- The exact response body shape from the completed `doneUrl` poll (token field name, any other metadata
  returned alongside it).
- Whether the `PUT`-based publish endpoint needs anything beyond the tarball body (content-type, checksum
  headers, etc).

## Sources

- <https://docs.npmjs.com/trusted-publishers/>
- <https://docs.npmjs.com/about-access-tokens/>
- <https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/>
- <https://github.com/orgs/community/discussions/179562>
- <https://github.com/npm/rfcs/discussions/93>
- <https://marmelab.com/blog/2022/12/22/how-to-implement-web-login-in-a-private-npm-registry.html>
