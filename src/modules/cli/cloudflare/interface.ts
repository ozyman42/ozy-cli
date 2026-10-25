import type { EffectGen } from "effective-modules";

/**
 * Obtaining a Cloudflare API token by driving a real browser on this machine.
 *
 * Cloudflare has no API for minting API tokens — creating one needs a credential that can already create
 * one, which is the thing you do not have. The dashboard form is the only route, so the daemon drives it.
 *
 * Driving a browser over CDP rather than from inside a page is what makes this possible at all: same-origin
 * policy, CORS and `X-Frame-Options` apply to pages, not to a process controlling a browser. It also means
 * the requests come from this machine with this person's own session, which is what a provider's fraud
 * checks expect to see.
 *
 * This is a first implementation of a pattern meant to generalise: a connection implementation supplies the
 * click-path, the daemon supplies the browser, and a credential comes back. Here both halves are Cloudflare
 * specific and the credential is printed rather than stored.
 */

export interface ApiTokenRequest {
  /** Shown in the Cloudflare dashboard's token list. */
  readonly name: string;
  /**
   * Permission group keys, as the dashboard's deep link names them — for example
   * `com.cloudflare.edge.worker.script.update`. These prefill the form so the fragile part of the UI,
   * the permission rows, never has to be scripted.
   */
  readonly permissionGroupKeys: ReadonlyArray<string>;
}

/** What the person chose, read back from where they chose it. */
export interface ApiToken {
  readonly token: string;
  readonly accountId: string;
}

export interface ICloudflare {
  /**
   * Opens a browser, waits for sign-in if needed, puts the person on Cloudflare's account chooser, and
   * then walks the token form unattended and returns what it was shown.
   *
   * Which account the token is for is the one thing this cannot work out: an account is a choice, not a
   * discoverable fact, and a person with several has to say which. So it is asked the only way a choice
   * should be asked — by showing them the screen where that choice is already made — rather than by
   * demanding an id up front. Everything on either side of that click is automated.
   *
   * Never silently gives up: any step that does not match leaves the browser open and asks on the terminal,
   * because a half-finished token form is still something a person can finish in five seconds, and a
   * dashboard's markup changes without warning.
   */
  createApiToken(request: ApiTokenRequest): EffectGen<ApiToken, string>;
}
