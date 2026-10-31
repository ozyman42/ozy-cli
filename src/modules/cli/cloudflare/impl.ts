import { Effect } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import type { BrowserContext, BrowserType, Page } from "playwright-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@/common/log";
import { cliModules } from "@/modules/cli";
import { commonModules } from "@/modules/common";
import type { ApiToken, ApiTokenRequest, ICloudflare } from "./interface";

const DASHBOARD = "https://dash.cloudflare.com";

/**
 * Browser-side source, passed as a string.
 *
 * It runs in the page, not in this process, so it needs DOM types this package does not compile with —
 * handing it over as source keeps the browser's globals out of the CLI's type environment rather than
 * widening `lib` for one function. 37 characters is Cloudflare's token length; the floor is deliberately
 * close to it so an unrelated hash on the page cannot be mistaken for a credential.
 */
const FIND_TOKEN_ON_PAGE = `() => {
  const shaped = /^[A-Za-z0-9_-]{37,}$/;
  const nodes = Array.from(document.querySelectorAll("input, textarea, code, pre"));
  for (const node of nodes) {
    const raw = (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
      ? node.value
      : (node.textContent || "");
    const value = raw.trim();
    if (shaped.test(value)) return value;
  }
  return undefined;
}`;

/**
 * A profile of its own, kept between runs.
 *
 * Signing in is the slowest and most human part of this, so it is done once rather than every time. It is
 * deliberately not the person's main Chrome profile: that would put every site they are signed into within
 * reach of a click-path, and nothing here needs more than Cloudflare.
 */
const profileDir = (): string => join(homedir(), ".ozy", "browser", "cloudflare");

export const CHROME_LAUNCH_OPTIONS = {
  headless: false,
  // The installed Chrome, not a downloaded Chromium: no 300MB fetch, and a browser the dashboard's
  // bot checks are used to seeing.
  channel: "chrome",
  // Playwright passes `--no-sandbox` unless this is true, and the window it opens is one a person signs in to.
  chromiumSandbox: true,
  viewport: null,
  args: ["--window-size=1280,900"],
} as const satisfies Parameters<BrowserType["launchPersistentContext"]>[1];

/** Long enough for a person to find a second factor; not so long that a forgotten window hangs the CLI. */
const HUMAN_TIMEOUT_MS = 5 * 60 * 1000;
const STEP_TIMEOUT_MS = 20 * 1000;

export class CloudflareImpl extends implementing(cliModules.Cloudflare)
  .uses(commonModules.OSPlatform)
  implements ICloudflare {

  *createApiToken(request: ApiTokenRequest): EffectGen<ApiToken, string> {
    // Loaded here, not at the top: playwright-core reads its own package.json at load time from the path
    // it had on the build machine, so a top-level import crashed every ozy command in the compiled binary.
    const { chromium } = yield* Effect.tryPromise({
      try: () => import("playwright-core"),
      catch: (cause) => `Could not load playwright-core: ${String(cause)}`,
    });
    const context = yield* Effect.tryPromise({
      try: () => chromium.launchPersistentContext(profileDir(), CHROME_LAUNCH_OPTIONS),
      catch: (cause) => `Could not start Chrome: ${String(cause)}`,
    });

    try {
      return yield* this.walkTokenForm(context, request);
    } finally {
      // Left open on purpose when something went wrong — see `finishByHand`. Closing here would take the
      // half-filled form away from the person who could finish it.
      yield* Effect.promise(() => context.close()).pipe(Effect.ignore);
    }
  }

  private *walkTokenForm(context: BrowserContext, request: ApiTokenRequest): EffectGen<ApiToken, string> {
    const page = context.pages()[0] ?? (yield* Effect.tryPromise({
      try: () => context.newPage(),
      catch: (cause) => `Could not open a tab: ${String(cause)}`,
    }));

    yield* this.signIn(page);
    const accountId = yield* this.chooseAccount(page);

    // The deep link carries the permissions, so the one genuinely fragile part of this form — the
    // permission rows, which are nested comboboxes — never has to be scripted.
    const url = new URL("/profile/api-tokens", DASHBOARD);
    url.searchParams.set("name", request.name);
    url.searchParams.set("permissionGroupKeys", JSON.stringify(request.permissions));
    url.searchParams.set("accountId", accountId);
    url.searchParams.set("zoneId", "all");

    log("Opening the token form with the permissions prefilled");
    yield* this.go(page, url.toString());

    const walked = yield* Effect.result(Effect.tryPromise({
      try: async () => {
        await page.getByRole("button", { name: /continue to summary/i }).click({ timeout: STEP_TIMEOUT_MS });
        await page.getByRole("button", { name: /create token/i }).click({ timeout: STEP_TIMEOUT_MS });
      },
      catch: (cause) => String(cause),
    }));
    const walkSucceeded = walked._tag === "Success";
    if (!walkSucceeded) {
      log("The form did not look the way this expected — leaving it open for you to finish.");
    }

    return { token: yield* this.readToken(page, walkSucceeded), accountId };
  }

  /**
   * Waits, rather than scripting a login: a password and a second factor are the person's to provide.
   *
   * Whether we are signed in cannot be read straight after `domcontentloaded`. The dashboard is a client-side
   * app that decides where you belong after it boots, so the URL at that moment is whatever was requested —
   * which made a brand-new profile report itself as already signed in, and every step after that fail against
   * a login page. So this waits for the redirect to happen rather than sampling the URL once.
   */
  private *signIn(page: Page): EffectGen<void, string> {
    yield* this.go(page, `${DASHBOARD}/profile/api-tokens`);

    const atLogin = yield* Effect.promise(() =>
      page.waitForURL((candidate) => candidate.toString().includes("/login"), { timeout: 10_000 })
        .then(() => true)
        .catch(() => false));

    if (!atLogin) {
      log("Already signed in to Cloudflare");
      return;
    }

    log("Sign in to Cloudflare in the window that just opened — waiting up to 5 minutes");
    yield* Effect.tryPromise({
      try: () => page.waitForURL((candidate) => !candidate.toString().includes("/login"), {
        timeout: HUMAN_TIMEOUT_MS,
      }),
      catch: () => "Timed out waiting for sign-in",
    });
    log("Signed in");
  }

  /**
   * Puts the person on Cloudflare's account list and waits for them to pick one.
   *
   * This is the only decision in the flow, so it is the only thing asked of them — and it is asked by
   * showing the screen where the choice already lives, not by demanding an id before the browser opens.
   * The dashboard puts the chosen account in the path, so their click is also how the answer is read
   * back; nothing has to be typed, copied, or confirmed afterwards.
   *
   * An account with only one choice still lands on that account's page, so this costs them nothing.
   */
  private *chooseAccount(page: Page): EffectGen<string, string> {
    const alreadyChosen = accountIdIn(page.url());
    if (alreadyChosen !== undefined) {
      log(`Using Cloudflare account ${alreadyChosen}`);
      return alreadyChosen;
    }

    log("Choose the Cloudflare account this token is for, in the window that just opened");
    yield* this.go(page, DASHBOARD);
    yield* Effect.tryPromise({
      try: () => page.waitForURL((candidate) => accountIdIn(candidate.toString()) !== undefined, {
        timeout: HUMAN_TIMEOUT_MS,
      }),
      catch: () => "Timed out waiting for an account to be chosen",
    });

    const accountId = accountIdIn(page.url());
    if (accountId === undefined) return yield* Effect.fail("Could not read the chosen account from the dashboard");
    log(`Using Cloudflare account ${accountId}`);
    return accountId;
  }

  private *go(page: Page, url: string): EffectGen<void, string> {
    yield* Effect.tryPromise({
      try: () => page.goto(url, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS * 2 }),
      catch: (cause) => `Could not open ${url}: ${String(cause)}`,
    });
  }

  /**
   * Reads the token off the page once it has been created.
   *
   * A created token is shown exactly once, so this is the only chance to capture it. When the scripted walk
   * did not match, this waits the full human timeout instead of the step timeout: the person is finishing
   * the form themselves in the window that is still open, and the token appears when they are done. That is
   * why there is no terminal prompt in the normal path — needing one would make this unusable from anything
   * that is not an interactive shell.
   *
   * The scan is a DOM sweep rather than a selector, because the value is rendered in a read-only input on
   * one layout and a `<code>` block on another, and both change without notice. A token's shape is the
   * stable thing about it.
   */
  private *readToken(page: Page, walkSucceeded: boolean): EffectGen<string, string> {
    const deadline = Date.now() + (walkSucceeded ? STEP_TIMEOUT_MS : HUMAN_TIMEOUT_MS);
    if (!walkSucceeded) log("Waiting for you to finish — the token will be picked up as soon as it appears");

    while (Date.now() < deadline) {
      const candidate = yield* Effect.promise(() =>
        page.evaluate<string | undefined>(FIND_TOKEN_ON_PAGE).catch(() => undefined));

      if (candidate !== undefined) {
        log("Token read from the page");
        return candidate;
      }
      yield* Effect.promise(() => page.waitForTimeout(1000));
    }

    return yield* this.finishByHand();
  }

  /** Last resort, and only reachable from an interactive shell: the window timed out with no token on it. */
  private *finishByHand(): EffectGen<string, string> {
    const osPlatform = this.dependencies.OSPlatform;
    const pasted = yield* osPlatform.promptInput(
      "Could not read the token automatically. Finish in the open browser window, then paste the token here: ",
    );
    const token = pasted.trim();
    if (token.length === 0) return yield* Effect.fail("No token provided");
    return token;
  }
}

/** The account id Cloudflare puts in the dashboard path once one is selected. */
const accountIdIn = (url: string): string | undefined =>
  /dash\.cloudflare\.com\/([0-9a-f]{32})(?:[/?#]|$)/.exec(url)?.[1];
