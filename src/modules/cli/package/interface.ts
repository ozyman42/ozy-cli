import type { EffectGen } from "effective-modules";
import type { Option } from "effect";
import type { Remote } from "../git/interface";
import type { PackageJson, PackageRef } from "./package-json";

export type { PackageJson, PackageRef } from "./package-json";

export interface PublishInput {
  packageRef: PackageRef;
  remote: Remote;
  privateAccess: boolean;
}

export interface IPackage {
  /**
   * Publishes the package in the current directory: ensures the GitHub repo exists (creating it if the
   * caller has permission), ensures the directory is a configured git repo, syncs package.json's
   * repository URL, and ensures the package is published to npm with trusted publishing configured.
   * packageRef/remote must already be known — this does not derive or search for them.
   */
  publish(input: PublishInput): EffectGen<void, string>;
  loadPackageJson(dir: string): EffectGen<Option.Option<PackageJson>, string>;
  writePackageJson(dir: string, packageJson: PackageJson): EffectGen<void, string>;
}
