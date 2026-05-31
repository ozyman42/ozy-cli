import { Effect, Option } from 'effect';

export interface PackageRegistryInfo {
  name: string;
  latestVersion: string;
  distTags: Record<string, string>;
}

export function fetchPackageInfo(name: string): Effect.Effect<Option.Option<PackageRegistryInfo>, string> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
      if (res.status === 404) return Option.none<PackageRegistryInfo>();
      if (!res.ok) throw new Error(`registry error ${res.status} for ${name}`);
      const data = await res.json() as any;
      return Option.some({
        name: data.name,
        latestVersion: data['dist-tags']?.latest,
        distTags: data['dist-tags'] ?? {},
      });
    },
    catch: (e) => e instanceof Error ? e.message : String(e),
  });
}
