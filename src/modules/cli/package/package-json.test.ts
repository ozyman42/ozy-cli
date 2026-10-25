import { Option, Effect, pipe, Result } from "effect";
import { describe, expect } from "bun:test";
import { validatePackageJson, encodePackageJson } from "./package-json";
import { test } from "@/common/effective-modules-extensions";

// TODO: in the future, different plugins should load define their own config JSON schema
//.      and this should get reflected in the JSON schema of the package.json

describe("parseNpmPackageJson", () => {
  
  test("missing fields get empty option", function*() {
    const decoded = yield* validatePackageJson(JSON.stringify({
      name: "name",
      extra: true,
      repository: {
        type: "git",
        url: "repourl"
      }
    }));

    expect(decoded).toEqual({
      name: {
        raw: "name",
        scope: Option.none(),
        packageName: "name"
      },
      version: Option.none(),
      repository: Option.some({ 
        type: "git",
        url: "repourl", 
        directory: Option.none() 
      }),
      files: Option.none(),
      // @ts-expect-error
      extra: true
    });
  });

  test("invalid package name causes error", function*() {
    const decodedResult = yield* pipe(
      validatePackageJson(JSON.stringify({
        name: "bad/@package"
      })),
      Effect.result
    );

    expect(Result.isFailure(decodedResult)).toBe(true);
    if (Result.isFailure(decodedResult)) {
      expect(decodedResult.failure.split("\n").map(line => line.trim())).toEqual([
        `Expected a string matching the RegExp ^(?:@[^/]+\\/[^/]+|(?!@)[^/]+)$, got "bad/@package"`,
        `at ["name"]`
      ]);
    }
  });

});

describe("encode", () => {

  test("round-trips a fully populated package.json, preserving excess properties", function*() {
    const raw = {
      name: "@scope/name",
      version: "1.2.3",
      repository: {
        type: "git",
        url: "git+https://github.com/owner/repo.git",
        directory: "packages/name",
      },
      files: ["dist"],
      extra: true,
    };

    const decoded = yield* validatePackageJson(JSON.stringify(raw));
    expect(decoded).toEqual({
      name: {
        scope: Option.some("scope"),
        raw: "@scope/name",
        packageName: "name"
      },
      version: Option.some("1.2.3"),
      repository: Option.some({
        type: "git",
        url: "git+https://github.com/owner/repo.git",
        directory: Option.some("packages/name")
      }),
      files: Option.some(["dist"]),
      // @ts-expect-error
      extra: true
    });
    const encoded = yield* encodePackageJson(decoded);

    expect(JSON.parse(encoded)).toEqual(raw);
  });

  test("omits fields that decoded to Option.none() instead of encoding them as null", function*() {
    const decoded = yield* validatePackageJson(JSON.stringify({
      name: "name",
      repository: {
        type: "git",
        url: "repourl",
      },
    }));

    const encoded = yield* encodePackageJson(decoded);
    const parsed = JSON.parse(encoded);

    expect(parsed).toEqual({
      name: "name",
      repository: { type: "git", url: "repourl" },
    });
    expect(parsed).not.toHaveProperty("version");
    expect(parsed).not.toHaveProperty("files");
    expect(parsed.repository).not.toHaveProperty("directory");
  });

});
