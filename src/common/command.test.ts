import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const fixture = resolve(import.meta.dir, "test-fixtures/run-command.ts");

const run = (outcome: "succeed" | "fail") =>
  Bun.spawnSync([process.execPath, fixture, outcome], { stdout: "pipe", stderr: "pipe" });

describe("makeCommand", () => {
  test("exits 1 when the action fails, so a caller can tell", () => {
    const result = run("fail");
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("✗ requested failure");
  });

  test("exits 0 when the action succeeds", () => {
    expect(run("succeed").exitCode).toBe(0);
  });
});
