import { Option } from "effect";
import { FUTURE_TOOL_NAME } from "@/common/constants";
import type { ECDHKeyPair } from "@/modules/common/crypto/interface";
import { CredentialId } from "@/modules/common/crypto/impl";
import { PrfInput } from "./prf-flow";

export interface UseOrCreatePasskeyPageInput {
  agentKeyPair: ECDHKeyPair;
  challenge: string;
  context: PrfInput;
  transportKeyContext: string;
  username: string;
}

type Mode = 'credential' | 'selectExisting' | 'create' | 'createOrSelect';
type ChainNode = { command: string; directory: Option.Option<string> };
type TreeNode = { label: string; children: TreeNode[] };

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nodeLabel(node: ChainNode): string {
  const dir = Option.getOrElse(() => '(cannot load dir)')(node.directory);
  return `${node.command}  ${dir}`;
}

function findCommonPrefixLen(chains: ReadonlyArray<ReadonlyArray<ChainNode>>): number {
  if (chains.length <= 1) return chains[0]?.length ?? 0;
  let len = 0;
  for (let i = 0; ; i++) {
    if (chains.some(c => i >= c.length)) break;
    const first = chains[0]![i]!;
    if (chains.some(c => c[i]!.command !== first.command)) break;
    len = i + 1;
  }
  return len;
}

function buildTreeNodes(chains: ReadonlyArray<ReadonlyArray<ChainNode>>, from: number): TreeNode[] {
  const groups = new Map<string, { chains: ReadonlyArray<ChainNode>[]; node: ChainNode }>();
  for (const chain of chains) {
    if (from >= chain.length) continue;
    const node = chain[from]!;
    const key = `${node.command}|${Option.getOrElse(() => '')(node.directory)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.chains.push(chain);
    } else {
      groups.set(key, { chains: [chain], node });
    }
  }
  return Array.from(groups.values()).map(({ chains: groupChains, node }) => ({
    label: nodeLabel(node),
    children: buildTreeNodes(groupChains, from + 1),
  }));
}

function renderTreeLines(nodes: TreeNode[], prefix: string): string[] {
  const lines: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    lines.push(escHtml(prefix + connector + node.label));
    lines.push(...renderTreeLines(node.children, childPrefix));
  }
  return lines;
}

function buildSignRequestTreeHtml(chains: ReadonlyArray<ReadonlyArray<ChainNode>>): string {
  if (chains.length === 0) return '';
  const commonPrefixLen = findCommonPrefixLen(chains);
  const minLen = Math.min(...chains.map(c => c.length));
  // Show at least 3 levels per branch; always include divergence point
  const displayStart = Math.max(0, Math.min(commonPrefixLen, minLen - 3));

  const rootNodes = buildTreeNodes(chains, displayStart);
  const lines: string[] = [];

  if (rootNodes.length === 1) {
    lines.push(escHtml(rootNodes[0]!.label));
    lines.push(...renderTreeLines(rootNodes[0]!.children, ''));
  } else {
    lines.push(...renderTreeLines(rootNodes, ''));
  }

  return `<pre class="tree">${lines.join('\n')}</pre>`;
}

function getContextInfo(context: PrfInput): { contextHtml: string; credentialId: string | null; mode: Mode; friendlyName: string | null } {
  return PrfInput.$match(context, {
    DerivePubkeyOnly: ({ credentialId: credOpt, pubkey }) => {
      const credIdBase58 = Option.getOrNull(credOpt);
      const credIdBase64 = credIdBase58 ? new CredentialId(credIdBase58).base64 : null;
      const mode: Mode = credIdBase64 !== null ? 'credential'
        : Option.isSome(pubkey) ? 'selectExisting'
        : 'createOrSelect';
      const friendlyName = credIdBase58 ? new CredentialId(credIdBase58).humanReadableName : null;
      const contextHtml = friendlyName && credIdBase58
        ? `<p style="color:#666;font-size:.95rem">Setup — confirming ownership of <strong>${escHtml(friendlyName)}</strong> (${escHtml(credIdBase58)})</p>`
        : '<p style="color:#666;font-size:.95rem">Setup — create or select a passkey for SSH signing</p>';
      return { contextHtml, credentialId: credIdBase64, mode, friendlyName };
    },
    DerivePubkeyForRequests: ({ session }) => {
      const chains = session.definition.expectedSignRequests.map(r => r.expectedCallerChain);
      const friendlyName = new CredentialId(session.credentialId).humanReadableName;
      const contextHtml = `<p style="color:#666;font-size:.95rem">Signing with <strong>${escHtml(friendlyName)}</strong> (${escHtml(session.credentialId)})</p>${buildSignRequestTreeHtml(chains)}`;
      return {
        contextHtml,
        credentialId: new CredentialId(session.credentialId).base64,
        mode: 'credential' as Mode,
        friendlyName,
      };
    },
  });
}

function buttonsHtml(mode: Mode, friendlyName: string | null): string {
  if (mode === 'createOrSelect') {
    return `<button class="btn" onclick="btnClick('create')">Create new passkey</button>` +
           `<button class="btn" onclick="btnClick('selectExisting')">Sign with existing passkey</button>`;
  }
  const label = mode === 'credential' && friendlyName ? `Sign with ${friendlyName}`
    : mode === 'selectExisting' ? 'Sign with existing passkey'
    : 'Create new passkey';
  return `<button class="btn" onclick="btnClick()">Authorize — ${label}</button>`;
}

export function useOrCreatePasskeyPage(input: UseOrCreatePasskeyPageInput): string {
  const { agentKeyPair, challenge, context, transportKeyContext, username } = input;
  const capitalizedName = FUTURE_TOOL_NAME.slice(0, 1).toLocaleUpperCase() + FUTURE_TOOL_NAME.slice(1);
  const title = `${capitalizedName} SSH Auth`;

  const { contextHtml, credentialId, mode, friendlyName } = getContextInfo(context);

  const cfg = JSON.stringify({
    agentPublicKey: agentKeyPair.base64Pubkey,
    challenge,
    credentialId,
    mode,
    username,
  }).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html>
<head><title>${title}</title><meta charset="utf-8">
<style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;text-align:center}
h1{font-size:1.5rem}#st{font-size:1.1rem;margin-top:20px}.ok{color:#060}.err{color:#d00}
.btn{margin:8px 4px;padding:10px 28px;font-size:1rem;cursor:pointer}.btn:disabled{cursor:default;opacity:.5}
.tree{font-family:monospace;text-align:left;font-size:.85rem;background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto;margin:16px 0}
</style>
</head>
<body>
<h1>${title}</h1>
${contextHtml}
${buttonsHtml(mode, friendlyName)}
<p id="st"></p>
<script>
const C=${cfg};
function bu(b){return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function fu(s){const b=atob(s.replace(/-/g,'+').replace(/_/g,'/'));const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
function btnClick(m){document.querySelectorAll('.btn').forEach(b=>b.disabled=true);main(m);}
async function main(modeOverride){
  const mode=modeOverride??C.mode;
  const st=document.getElementById('st');
  const fid=new URLSearchParams(location.search).get('id');
  try{
    const ch=fu(C.challenge);
    const salt=new Uint8Array(32);new TextEncoder().encodeInto('${FUTURE_TOOL_NAME}-prf-v1',salt);
    let cred;
    if(mode==='credential'){
      cred=await navigator.credentials.get({publicKey:{
        challenge:ch,userVerification:'required',
        allowCredentials:[{type:'public-key',id:fu(C.credentialId)}],
        extensions:{prf:{eval:{first:salt}}}
      }});
    }else if(mode==='selectExisting'){
      cred=await navigator.credentials.get({publicKey:{
        challenge:ch,userVerification:'required',
        extensions:{prf:{eval:{first:salt}}}
      }});
    }else{
      cred=await navigator.credentials.create({publicKey:{
        challenge:ch,rp:{name:'${FUTURE_TOOL_NAME} challenge'},
        user:{id:crypto.getRandomValues(new Uint8Array(16)),name:C.username,displayName:C.username+' — ${capitalizedName} SSH Key'},
        pubKeyCredParams:[{alg:-7,type:'public-key'}],
        authenticatorSelection:{authenticatorAttachment:'platform',userVerification:'required',residentKey:'required'},
        extensions:{prf:{eval:{first:salt}}}
      }});
    }
    const prf=cred.getClientExtensionResults().prf?.results?.first;
    if(!prf)throw Object.assign(new Error('PRF extension not returned — authenticator may not support PRF'),{noRetry:true});
    const ap=await crypto.subtle.importKey('raw',fu(C.agentPublicKey),{name:'ECDH',namedCurve:'P-256'},false,[]);
    const bkp=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
    const sh=await crypto.subtle.deriveBits({name:'ECDH',public:ap},bkp.privateKey,256);
    const hk=await crypto.subtle.importKey('raw',sh,'HKDF',false,['deriveKey']);
    const ak=await crypto.subtle.deriveKey(
      {name:'HKDF',hash:'SHA-256',salt:new Uint8Array(32),info:new TextEncoder().encode('${transportKeyContext}')},
      hk,{name:'AES-GCM',length:256},false,['encrypt']
    );
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const enc=await crypto.subtle.encrypt({name:'AES-GCM',iv},ak,prf);
    const bp=await crypto.subtle.exportKey('raw',bkp.publicKey);
    const r=await fetch('/seed?id='+fid,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({encryptedSeed:bu(enc),iv:bu(iv),browserPublicKey:bu(bp),credentialId:bu(cred.rawId)})});
    if(!r.ok)throw new Error('Agent returned '+r.status);
    const d=await r.json();
    st.className='ok';st.textContent='Authorized as '+d.friendlyName+'. You can close this tab.';
  }catch(e){
    const cancelled=e&&(e.name==='NotAllowedError'||e.name==='AbortError');
    await fetch('/error?id='+fid,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({cancelled,message:e?.message??String(e)})}).catch(()=>{});
    st.className='err';st.textContent=(cancelled?'Cancelled or passkey not found.':'Error: '+(e?.message??e))+' You can close this tab.';
  }
}
</script>
</body></html>`;
}
