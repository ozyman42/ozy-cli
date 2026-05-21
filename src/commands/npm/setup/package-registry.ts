export interface PackageRegistryInfo {
  name: string;
  latestVersion: string;
  distTags: Record<string, string>;
}

export async function fetchPackageInfo(name: string): Promise<PackageRegistryInfo | null> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`registry error ${res.status} for ${name}`);
  const data = await res.json() as any;
  return {
    name: data.name,
    latestVersion: data['dist-tags']?.latest,
    distTags: data['dist-tags'] ?? {},
  };
}
