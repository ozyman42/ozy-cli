- Set up any git repo to use a passkey-based SSH key. 
  Auto registers SSH authn and signing keys with github.
- Auto provision npm packages and set up trusted publishing. Precursor to jive.sh tool

## Follow-up investigations

- Verify Windows package-manager behavior when an entrypoint command name includes literal `.exe` text, including names that already end with `.exe` such as `src/entrypoints/foo.exe.ts`.
- Define how the build should handle source files that import runtime assets or modules outside `src`.
