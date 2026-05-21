import { $ } from 'bun';
import { createInterface } from 'node:readline';
import { log } from '../../../common/log';

function encodePackageName(name: string): string {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const slash = name.indexOf('/');
  return `@${name.slice(1, slash)}%2F${name.slice(slash + 1)}`;
}

function promptPasscode(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  enter the passcode from the browser: ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Returns the OTP that was used (if any), so callers can reuse it for subsequent requests.
// Returns the OTP used (if any) so callers can reuse it for the next request.
// alreadyExists: treat this status code as "already configured" rather than an error.
async function registryPost(
  url: string,
  body: string,
  authToken: string,
  { existingOtp, alreadyExistsStatus }: { existingOtp?: string; alreadyExistsStatus?: number } = {},
): Promise<{ otp?: string; alreadyExists: boolean }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
  };

  const post = (otp?: string) => fetch(url, {
    method: 'POST',
    headers: otp ? { ...headers, 'npm-otp': otp } : headers,
    body,
  });

  const check = (res: Response) => {
    if (res.ok) return true;
    if (alreadyExistsStatus && res.status === alreadyExistsStatus) return true;
    return false;
  };

  // Try with a pre-existing OTP first to avoid an unnecessary browser flow.
  if (existingOtp) {
    const res = await post(existingOtp);
    if (check(res)) return { otp: existingOtp, alreadyExists: !res.ok };
  }

  let res = await post();
  if (check(res)) return { otp: undefined, alreadyExists: !res.ok };

  if (res.status === 401) {
    const notice = res.headers.get('npm-notice') ?? '';
    const loginUrl = notice.match(/https:\/\/www\.npmjs\.com\/login\/[a-f0-9-]+/)?.[0];
    if (!loginUrl) throw new Error('2FA required but could not parse login URL');
    await $`open ${loginUrl}`.quiet().nothrow();
    const otp = await promptPasscode();
    res = await post(otp);
    if (check(res)) return { otp, alreadyExists: !res.ok };
  }

  throw new Error(`${res.status} ${await res.text()}`);
}

export async function addTrustedPublisher(
  name: string,
  ownerRepo: string,
  token: string,
  environment = 'prod',
): Promise<{ alreadyConfigured: boolean; otp?: string }> {
  const encoded = encodePackageName(name);
  log('  setting up (may require 2FA)...');
  const body = JSON.stringify([{
    type: 'github',
    claims: { repository: ownerRepo, workflow_ref: { file: 'publish.yml' }, environment },
    permissions: ['createPackage'],
  }]);
  try {
    const { otp, alreadyExists } = await registryPost(
      `https://registry.npmjs.org/-/package/${encoded}/trust`, body, token,
      { alreadyExistsStatus: 409 },
    );
    return { alreadyConfigured: alreadyExists, otp };
  } catch (e: any) {
    throw new Error(`trust setup failed: ${e.message}`);
  }
}

export async function setPackageAccessPolicy(name: string, token: string, existingOtp?: string): Promise<void> {
  const encoded = encodePackageName(name);
  const body = JSON.stringify({ publish_requires_tfa: true, automation_token_overrides_tfa: false });
  try {
    await registryPost(
      `https://registry.npmjs.org/-/package/${encoded}/access`, body, token,
      { existingOtp },
    );
  } catch (e: any) {
    throw new Error(`access policy setup failed: ${e.message}`);
  }
}
