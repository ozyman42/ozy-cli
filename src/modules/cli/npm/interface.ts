import type { EffectGen } from "effective-modules";
import { Data } from "effect";
import type { PackageRef } from "../package/interface";

export interface NpmUser {
  readonly token: string;
  readonly username: string;
}

export interface NpmPublishInput {
  readonly tarPath: string;
  readonly access: "public" | "restricted";
}

export interface NpmTrustedPublisherInput {
  readonly packageName: string;
  readonly ownerRepo: string;
  readonly token: string;
}

export interface NpmTrustedPublisherResult {
  readonly alreadyConfigured: boolean;
  readonly otp?: string;
}

export interface NpmPackageAccessPolicyInput {
  readonly packageName: string;
  readonly token: string;
  readonly existingOtp?: string;
  readonly publicAccess: boolean;
}

export type NpmPackageWriteAccess = Data.TaggedEnum<{
  ExistingPackage: {
    readonly packageName: string;
    readonly user: string;
    readonly summary: string;
    readonly latestVersion?: string;
  };
  NewUnscopedPackage: {
    readonly packageName: string;
    readonly user: string;
    readonly summary: string;
  };
  NewUserScopedPackage: {
    readonly packageName: string;
    readonly user: string;
    readonly scope: string;
    readonly summary: string;
  };
  NewOrganizationScopedPackage: {
    readonly packageName: string;
    readonly user: string;
    readonly scope: string;
    readonly summary: string;
  };
}>;
export const NpmPackageWriteAccess = Data.taggedEnum<NpmPackageWriteAccess>();

export interface INpm {
  ensureMinimumVersion(minimumVersion: string): EffectGen<string, string>;
  login(): EffectGen<NpmUser, string>;
  /** Verifies the current npm identity can publish this package name or fails with the missing access. */
  ensurePackageWriteAccess(user: NpmUser, packageName: PackageRef): EffectGen<NpmPackageWriteAccess, string>;
  publish(user: NpmUser, input: NpmPublishInput): EffectGen<void, string>;
  ensureTrustedPublisher(input: NpmTrustedPublisherInput): EffectGen<NpmTrustedPublisherResult, string>;
  setPackageAccessPolicy(input: NpmPackageAccessPolicyInput): EffectGen<void, string>;
}
