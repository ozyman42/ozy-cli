import { Option } from "effect";
import { FUTURE_TOOL_NAME } from "../../common/constants";
import type { CredentialId } from "../crypto/impl";
import { Action, type Repo, type User } from "./interface";
import type { ECDHKeyPair } from "../crypto/interface";

export interface UseOrCreatePasskeyPageInput {
  agentKeyPair: ECDHKeyPair;
  challenge: string;
  credentialId: Option.Option<CredentialId>;
  actions: Action[];
  user: User;
  transportKeyContext: string;
}

export function useOrCreatePasskeyPage(input: UseOrCreatePasskeyPageInput): string {
  const { agentKeyPair, challenge, credentialId, transportKeyContext, user, actions } = input;
  const capitalizedName = FUTURE_TOOL_NAME.slice(0, 1).toLocaleUpperCase() + FUTURE_TOOL_NAME.slice(1);
  function repoToSt(repo: Repo) {
    return `${repo.owner}/${repo.name}`;
  }
  const actionsDisplay = actions.map(Action.$match({
    Commit: ({message, repo}) => `Committing on ${repoToSt(repo)}: "${message}"`,
    Push: ({repo}) => `Pushing to ${repoToSt(repo)}`,
    Pull: ({repo}) => `Pulling from ${repoToSt(repo)}`,
    Clone: ({repo}) => `Cloning ${repoToSt(repo)}`,
    Setup: ({repos}) => {
      const signingKeyCreationMsg = Option.isNone(credentialId) ? ` signing key for ${user.name} and` : "";
      const multipleRepos = repos.length > 1 ? "s" : '';
      return `Creating${signingKeyCreationMsg} deploy key${multipleRepos} for repo${multipleRepos} ${repos.map(repoToSt).join(", ")}`
    }
  }));
  const actionsHtml = actionsDisplay.length > 1 ?
    `<ul>${actionsDisplay.map(actionsDisplayItem => `<li>${actionsDisplayItem}</li>`)}</ul>` :
    `<p>${actionsDisplay[0]}</p>`
  const title = `${capitalizedName} Git Auth`;
  // Escape </script> sequences in JSON to prevent early script tag termination
  const cfg = JSON.stringify({
    agentPublicKey: agentKeyPair.base64Pubkey,
    challenge,
    credentialId: Option.getOrNull(credentialId)
  }).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head><title>${title}</title><meta charset="utf-8">
<style>
body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;text-align:center}
h1{font-size:1.5rem}p{color:#555}#st{font-size:1.1rem;margin-top:20px}.ok{color:#060}.err{color:#d00}
#btn{margin-top:24px;padding:10px 28px;font-size:1rem;cursor:pointer}#btn:disabled{cursor:default;opacity:.5}
</style>
</head>
<body>
<h1>${title}</h1>
<p>Authorizing as ${user.name} &lt;${user.email}&gt;</p>
${actionsHtml}
<button id="btn">Authorize</button>
<p id="st"></p>
<script>
const C=${cfg};
function bu(b){return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}
function fu(s){const b=atob(s.replace(/-/g,'+').replace(/_/g,'/'));const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
async function main(){
  const st=document.getElementById('st');
  try{
    const ch=fu(C.challenge);
    const salt=new Uint8Array(32);new TextEncoder().encodeInto('${FUTURE_TOOL_NAME}-prf-v1',salt);
    let cred;
    if(C.credentialId){
      cred=await navigator.credentials.get({publicKey:{
        challenge:ch,userVerification:'required',
        allowCredentials:[{type:'public-key',id:fu(C.credentialId)}],
        extensions:{prf:{eval:{first:salt}}}
      }});
    }else{
      cred=await navigator.credentials.create({publicKey:{
        challenge:ch,rp:{name:'${FUTURE_TOOL_NAME} challenge'},
        user:{id:crypto.getRandomValues(new Uint8Array(16)),name:'${FUTURE_TOOL_NAME}-${user.name}',displayName:'${capitalizedName} Git SSH Key (${user.name})'},
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
    const r=await fetch('/seed',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({encryptedSeed:bu(enc),iv:bu(iv),browserPublicKey:bu(bp),credentialId:bu(cred.rawId)})});
    if(!r.ok)throw new Error('Agent returned '+r.status);
    st.className='ok';st.textContent='Success! You can close this tab.';
  }catch(e){
    const cancelled=e&&(e.name==='NotAllowedError'||e.name==='AbortError');
    await fetch('/error',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({cancelled,message:e?.message??String(e)})}).catch(()=>{});
    st.className='err';st.textContent=(cancelled?'Cancelled or passkey not found.':'Error: '+(e?.message??e))+' You can close this tab.';
  }
}
document.getElementById('btn').addEventListener('click',function(){
  this.disabled=true;
  main();
});
</script>
</body></html>`;
}
