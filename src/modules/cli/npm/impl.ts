import { Effect, FileSystem, Option, Result, pipe } from "effect";
import { HttpBody, HttpClient, HttpClientError, HttpClientResponse, Headers } from "effect/http";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { homedir } from "node:os";
import { cliModules } from "@/modules/cli";
import { commonModules } from "@/modules/common";
import { log } from "@/common/log";
import type { ProcessResult } from "@/modules/common/os-platform/interface";
import { NpmPackageWriteAccess, type INpm, type NpmUser, type NpmPackageAccessPolicyInput, type NpmPublishInput, type NpmTrustedPublisherInput, type NpmTrustedPublisherResult } from "./interface";
import type { PackageRef } from "../package/interface";

type ParsedVersion = readonly [major: number, minor: number, patch: number];

const npmrcPath = `${homedir()}/.npmrc`;
const TOKEN_RE = /^\/\/registry\.npmjs\.org\/:_authToken=(\S+)$/m;

export class NpmImpl extends implementing(cliModules.Npm).uses(commonModules.OSPlatform, FileSystem.FileSystem, HttpClient.HttpClient) implements INpm {
  *ensureMinimumVersion(minimumVersion: string): EffectGen<string, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({ command: "npm", args: ["--version"] });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`"npm" not found in PATH — install Node.js from nodejs.org`);
    }

    const version = commandStdout(result);
    const installed = parseVersion(version);
    const minimum = parseVersion(minimumVersion);
    if (!installed) {
      return yield* Effect.fail(`npm reported an invalid version: ${version}`);
    }
    if (!minimum) {
      return yield* Effect.fail(`minimum npm version is invalid: ${minimumVersion}`);
    }
    if (compareVersions(installed, minimum) < 0) {
      return yield* Effect.fail(`installed npm ${version} is too old — npm ${minimumVersion}+ is required`);
    }

    return version;
  }

  // TODO: this shells out to `npm login` and scrapes ~/.npmrc for the resulting token. npm's own web-login
  // handshake can be called directly instead, the same way GitHubImpl.authorize implements GitHub's OAuth
  // flow without shelling out — see ./no-cli-auth.md for the protocol, verified token lifetime/scope, and
  // open questions to confirm before implementing.
  *login(): EffectGen<NpmUser, string> {
    const existing = (yield* this.readNpmrc()).match(TOKEN_RE)?.[1];
    if (existing) {
      const usernameOption = yield* this.whoamiWithToken(existing);
      if (Option.isSome(usernameOption)) {
        yield* this.stripTokenFromDisk();
        return { token: existing, username: usernameOption.value };
      }
    }

    log("  not logged in — opening npm login...");
    const loginResult = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "npm",
      args: ["login"],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (loginResult.exitCode !== 0) {
      return yield* Effect.fail("npm login failed — try running \"npm login\" manually");
    }

    const token = (yield* this.readNpmrc()).match(TOKEN_RE)?.[1];
    if (!token) {
      return yield* Effect.fail('npm login did not produce a token — try running "npm login" manually');
    }

    const usernameOption = yield* this.whoamiWithToken(token);
    if (Option.isNone(usernameOption)) {
      return yield* Effect.fail("npm login succeeded but token verification failed");
    }

    yield* this.stripTokenFromDisk();
    return { token, username: usernameOption.value };
  }

  *ensurePackageWriteAccess(user: NpmUser, packageName: PackageRef): EffectGen<NpmPackageWriteAccess, string> {
    const rawName = packageName.raw;
    const metadataOption = yield* this.loadPackageMetadata(rawName, user.token);

    if (Option.isSome(metadataOption)) {
      const collaboratorAccess = yield* this.loadCollaboratorAccess(rawName, user.token, user.username);
      if (collaboratorAccess !== "read-write") {
        return yield* Effect.fail(`${user.username} does not have write access to existing package ${rawName}`);
      }
      return NpmPackageWriteAccess.ExistingPackage({
        packageName: rawName,
        user: user.username,
        summary: `${user.username} has write access to ${rawName}`,
        latestVersion: metadataOption.value.latestVersion,
      });
    }

    if (Option.isNone(packageName.scope)) {
      return NpmPackageWriteAccess.NewUnscopedPackage({
        packageName: rawName,
        user: user.username,
        summary: `${rawName} is available for first publish`,
      });
    }

    const scope = packageName.scope.value;
    if (scope.toLowerCase() === user.username.toLowerCase()) {
      return NpmPackageWriteAccess.NewUserScopedPackage({
        packageName: rawName,
        user: user.username,
        scope,
        summary: `${rawName} is available under ${user.username}'s user scope`,
      });
    }

    const hasScopeAccess = yield* this.userIsInDevelopersTeam(scope, user.token, user.username);
    if (!hasScopeAccess) {
      return yield* Effect.fail(`${user.username} is not in @${scope}:developers, so new packages cannot be published under @${scope}`);
    }
    return NpmPackageWriteAccess.NewOrganizationScopedPackage({
      packageName: rawName,
      user: user.username,
      scope,
      summary: `${user.username} can publish new packages under @${scope}`,
    });
  }

  *publish(user: NpmUser, { tarPath, access }: NpmPublishInput): EffectGen<void, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "npm",
      args: ["publish", tarPath, "--access", access],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: npmEnv(user.token),
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`npm publish failed with exit code ${result.exitCode}`);
    }
  }

  *ensureTrustedPublisher({ packageName, ownerRepo, token }: NpmTrustedPublisherInput): EffectGen<NpmTrustedPublisherResult, string> {
    const encoded = encodePackageName(packageName);
    log('  setting up (may require 2FA)...');
    const body = JSON.stringify([{
      type: 'github',
      claims: { repository: ownerRepo, workflow_ref: { file: 'pipeline.yml' } },
      permissions: ['createPackage'],
    }]);
    const { otp, alreadyExists } = yield* this.registryPost(
      `https://registry.npmjs.org/-/package/${encoded}/trust`,
      body,
      token,
      { alreadyExistsStatus: 409 },
    );
    return { alreadyConfigured: alreadyExists, otp };
  }

  *setPackageAccessPolicy({ packageName, token, existingOtp, publicAccess }: NpmPackageAccessPolicyInput): EffectGen<void, string> {
    const encoded = encodePackageName(packageName);
    const body = JSON.stringify({
      publish_requires_tfa: true,
      automation_token_overrides_tfa: false,
      access: publicAccess ? "public" : "private"
    });
    yield* this.registryPost(
      `https://registry.npmjs.org/-/package/${encoded}/access`,
      body,
      token,
      { existingOtp },
    );
  }

  private *whoamiWithToken(token: string): EffectGen<Option.Option<string>> {
    const runResult = yield* Effect.result(effunct(this.dependencies.OSPlatform.spawnProcess)({
      command: "npm",
      args: ["whoami"],
      env: npmEnv(token),
    }));
    if (Result.isFailure(runResult)) return Option.none();
    const result = runResult.success;
    if (result.exitCode !== 0) return Option.none();
    return Option.some(commandStdout(result));
  }

  private *loadPackageMetadata(packageName: string, token: string): EffectGen<Option.Option<NpmPackageMetadata>, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "npm",
      args: ["view", packageName, "--json"],
      env: npmEnv(token),
    });
    const stdout = commandStdout(result);
    const output = commandOutput(result);
    if (result.exitCode !== 0) {
      if (isNpmNotFound(output)) return Option.none();
      return yield* Effect.fail(`npm package lookup failed for ${packageName}: ${summarizeOutput(output)}`);
    }

    const parsed = yield* parseJsonOutput(stdout, `npm view ${packageName}`);
    const latestVersion = latestVersionFromPackageMetadata(parsed);
    return Option.some({ latestVersion });
  }

  private *loadCollaboratorAccess(packageName: string, token: string, user: string): EffectGen<string | undefined, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "npm",
      args: ["access", "list", "collaborators", packageName, user, "--json"],
      env: npmEnv(token),
    });
    const stdout = commandStdout(result);
    const output = commandOutput(result);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`npm access lookup failed for ${packageName}: ${summarizeOutput(output)}`);
    }

    const parsed = yield* parseJsonOutput(stdout, `npm access list collaborators ${packageName} ${user}`);
    return collaboratorAccessFromJson(parsed, user);
  }

  private *userIsInDevelopersTeam(scope: string, token: string, user: string): EffectGen<boolean, string> {
    const teamName = `@${scope}:developers`;
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "npm",
      args: ["team", "ls", teamName, "--json"],
      env: npmEnv(token),
    });
    const stdout = commandStdout(result);
    const output = commandOutput(result);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`npm scope access lookup failed for @${scope}: ${summarizeOutput(output)}`);
    }

    const parsed = yield* parseJsonOutput(stdout, `npm team ls ${teamName}`);
    return jsonContainsUser(parsed, user);
  }

  private *readNpmrc(): EffectGen<string> {
    const fileSystem = this.getDependency(FileSystem.FileSystem);
    const result = yield* Effect.result(fileSystem.readFileString(npmrcPath));
    return Result.isSuccess(result) ? result.success : "";
  }

  private *stripTokenFromDisk(): EffectGen<void> {
    const fileSystem = this.getDependency(FileSystem.FileSystem);
    const content = yield* this.readNpmrc();
    const stripped = content.replace(TOKEN_RE, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!stripped) {
      yield* Effect.result(fileSystem.remove(npmrcPath));
    } else {
      yield* Effect.result(fileSystem.writeFileString(npmrcPath, `${stripped}\n`));
    }
  }

  private *registryFetch(
    request: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
    context: string,
  ): EffectGen<HttpClientResponse.HttpClientResponse, string> {
    return yield* pipe(request, Effect.mapError(e => `${context}: ${String(e)}`));
  }

  private *registryResponseText(response: HttpClientResponse.HttpClientResponse, context: string): EffectGen<string, string> {
    return yield* pipe(response.text, Effect.mapError(e => `${context}: ${String(e)}`));
  }

  private *registryPost(
    url: string,
    body: string,
    authToken: string,
    { existingOtp, alreadyExistsStatus }: { existingOtp?: string; alreadyExistsStatus?: number } = {},
  ): EffectGen<{ otp?: string; alreadyExists: boolean }, string> {
    const client = this.getDependency(HttpClient.HttpClient);
    const osPlatform = this.dependencies.OSPlatform;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    };

    const post = (otp?: string) => client.post(url, {
      headers: otp ? { ...headers, 'npm-otp': otp } : headers,
      body: HttpBody.text(body, 'application/json'),
    });

    const check = (res: HttpClientResponse.HttpClientResponse) => {
      if (isOkStatus(res.status)) return true;
      if (alreadyExistsStatus && res.status === alreadyExistsStatus) return true;
      return false;
    };

    if (existingOtp) {
      const response = yield* this.registryFetch(post(existingOtp), 'npm registry request failed');
      if (check(response)) return { otp: existingOtp, alreadyExists: !isOkStatus(response.status) };
    }

    let response = yield* this.registryFetch(post(), 'npm registry request failed');
    if (check(response)) return { otp: undefined, alreadyExists: !isOkStatus(response.status) };

    if (response.status === 401) {
      const loginUrl = Option.flatMap(
        Headers.get(response.headers, 'npm-notice'),
        notice => Option.fromNullishOr(notice.match(/https:\/\/www\.npmjs\.com\/login\/[a-f0-9-]+/)?.[0]),
      );
      if (Option.isNone(loginUrl)) return yield* Effect.fail('2FA required but could not parse login URL');
      yield* osPlatform.openBrowserWindow(loginUrl.value);
      const otp = yield* osPlatform.promptInput('  enter the passcode from the browser: ');
      response = yield* this.registryFetch(post(otp), 'npm registry request failed');
      if (check(response)) return { otp, alreadyExists: !isOkStatus(response.status) };
    }

    const text = yield* this.registryResponseText(response, 'failed to read npm registry response');
    return yield* Effect.fail(`${response.status} ${text}`);
  }
}

interface NpmPackageMetadata {
  readonly latestVersion?: string;
}

function npmEnv(token: string): NodeJS.ProcessEnv {
  return { ...process.env, NODE_AUTH_TOKEN: token };
}

function commandStdout(result: ProcessResult): string {
  return result.stdout.trim();
}

function commandOutput(result: ProcessResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function summarizeOutput(output: string): string {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.at(-1) ?? "unknown npm error";
}

function isNpmNotFound(output: string): boolean {
  return /\bE404\b|404 Not Found|not in this registry|not found/i.test(output);
}

function* parseJsonOutput(output: string, command: string): EffectGen<unknown, string> {
  return yield* Effect.try({
    try: () => JSON.parse(output),
    catch: () => `${command} returned invalid JSON: ${summarizeOutput(output)}`,
  });
}

function latestVersionFromPackageMetadata(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const version = value["version"];
  const distTags = value["dist-tags"];
  if (isRecord(distTags) && typeof distTags["latest"] === "string") return distTags["latest"];
  return typeof version === "string" ? version : undefined;
}

function collaboratorAccessFromJson(value: unknown, user: string): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const access = collaboratorAccessFromJson(item, user);
      if (access) return access;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  for (const [key, access] of Object.entries(value)) {
    if (key.toLowerCase() === user.toLowerCase() && typeof access === "string") {
      return access;
    }
  }
  if (typeof value["access"] === "string") return value["access"];
  if (typeof value["permission"] === "string") return value["permission"];
  return undefined;
}

function jsonContainsUser(value: unknown, user: string): boolean {
  if (typeof value === "string") return value.toLowerCase() === user.toLowerCase();
  if (Array.isArray(value)) return value.some(item => jsonContainsUser(item, user));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    if (key.toLowerCase() === user.toLowerCase()) return true;
    if (typeof entry === "string") return entry.toLowerCase() === user.toLowerCase();
    if (isRecord(entry)) {
      return ["name", "user", "username"].some(field => {
        const candidate = entry[field];
        return typeof candidate === "string" && candidate.toLowerCase() === user.toLowerCase();
      });
    }
    return false;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < left.length; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function encodePackageName(name: string): string {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const slash = name.indexOf('/');
  return `@${name.slice(1, slash)}%2F${name.slice(slash + 1)}`;
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

