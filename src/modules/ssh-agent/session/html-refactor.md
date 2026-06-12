# HTML Refactor: passkey-prf-page

## Problem
`passkey-prf-page.ts` generates HTML+JS via string templates. The embedded browser script (escape noise, no type checking, no IDE support) makes it hard to read and maintain.

## Proposed approach
Split into three layers:

```
passkey-prf-browser.ts          ← real TypeScript; browser DOM/WebAuthn code with full IDE support
        ↓ Bun.build (added to build.ts before main binary compile)
passkey-prf-browser-bundle.ts   ← generated file: export const BROWSER_BUNDLE = "..."
        ↓ imported by
passkey-prf-page.tsx            ← JSX template; <script>{BROWSER_BUNDLE}</script>
```

## build.ts change
Before compiling `ozy-signing-agent`, add one `Bun.build` call targeting `passkey-prf-browser.ts` with `target: 'browser'` and `minify: true`. Write the first output's text to `passkey-prf-browser-bundle.ts` as a generated string constant. The generated file should be gitignored or marked as generated.

## Benefits
- Browser code can import shared constants (e.g. `FUTURE_TOOL_NAME`) — TypeScript catches mismatches
- HTML template is plain JSX — no backslash escaping, readable structure
- `<script>` block is just `{BROWSER_BUNDLE}` — no structural noise
