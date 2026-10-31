import { describe, expect, test } from "bun:test";
import { CHROME_LAUNCH_OPTIONS } from "./impl";

describe("CHROME_LAUNCH_OPTIONS", () => {
  test("keeps Chrome's sandbox on, so Playwright does not add --no-sandbox", () => {
    expect(CHROME_LAUNCH_OPTIONS.chromiumSandbox).toBe(true);
  });
});
