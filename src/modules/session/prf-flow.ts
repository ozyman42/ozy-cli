import { Effect, Option, pipe, Deferred, Scope } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { Action, SessionError, type DerivedKeys, type User } from "./interface";
import { AgentModules, agentModules } from "../agent-modules";
import { FUTURE_TOOL_NAME } from "../../common/constants";
import { CredentialId } from "../crypto/impl";
import { useOrCreatePasskeyPage } from "./passkey-prf-page";
import { CommonModules, commonModules } from "../common-modules";
import { log } from "../../common/log";
import { getKey } from "./generate-ssh-keypair";
import type { SSHKey } from "../crypto/interface";

type BrowserResult = {
  seed: Uint8Array;
  credentialId: CredentialId;
};

const TRANSPORT_KEY_CONTEXT = `${FUTURE_TOOL_NAME}-transport-v1`;

export function* prfFlow(actions: Action[], maybeCredentialId: Option.Option<CredentialId>, user: User): EffectGen<DerivedKeys, SessionError, AgentModules.Crypto | CommonModules.OSPlatform | Scope.Scope> {
  const crypto = yield* agentModules.Crypto;
  const osPlatform = yield* commonModules.OSPlatform;

  const agentKeyPair = yield* pipe(
    effunct(crypto.createECDHKey)(),
    Effect.catch(err => Effect.fail(SessionError.InternalError({reason: err})))
  );

  const challenge = yield* crypto.getRandomChallenge();

  const deferred = yield* Deferred.make<BrowserResult, SessionError>();

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          credentialId
          if (url.pathname === "/" && req.method === "GET") {
            return new Response(
              useOrCreatePasskeyPage({
                agentKeyPair, challenge, credentialId: maybeCredentialId,
                user, actions,
                transportKeyContext: TRANSPORT_KEY_CONTEXT,
              }),
              { headers: { "Content-Type": "text/html; charset=utf-8" } }
            );
          }
          if (url.pathname === "/seed" && req.method === "POST") {
            try {
              const body = await req.json() as {
                encryptedSeed: string; iv: string;
                browserPublicKey: string; credentialId: string;
              };
              Effect.runFork(Effect.gen(function*() {
                const decrypted = yield* crypto.decrypt({
                  senderPubkey: body.browserPublicKey,
                  receiverKey: agentKeyPair.keyPair,
                  cipherText: body.encryptedSeed,
                  iv: body.iv,
                  hkdfInfo: TRANSPORT_KEY_CONTEXT
                });
                const completed = yield* Deferred.succeed(deferred, {
                  seed: decrypted,
                  credentialId: CredentialId.fromBase64(body.credentialId),
                });
                if (!completed) {
                  return yield* Effect.fail(SessionError.InternalError({
                    reason: `Detected multiple POSTS to seed endpoint`
                  }))
                }
              }));
              return new Response(JSON.stringify({ ok: true }), {
                headers: { "Content-Type": "application/json" },
              });
            } catch (e) {
              console.error("[/seed handler error]", e);
              Effect.runFork(Deferred.fail(deferred, SessionError.InternalError({
                reason: (e as Error).toString()
              })));
              return new Response(JSON.stringify({ error: String(e) }), {
                status: 500, headers: { "Content-Type": "application/json" },
              });
            }
          }
          if (url.pathname === "/error" && req.method === "POST") {
            const body = await req.json() as { cancelled: boolean; message: string };
            const error = body.cancelled ? SessionError.WebAuthnCancelled() : SessionError.InternalError({reason: body.message});
            Effect.runFork(Deferred.fail(deferred, error));
            return new Response(JSON.stringify({ ok: true }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("Not found", { status: 404 });
        },
      })
    ),
    (server) => Effect.sync(() => server.stop())
  );

  log(`Opening browser for WebAuthn PRF on port ${server.port}`);
  yield* osPlatform.openBrowserWindow(`http://localhost:${server.port}/`);

  const { seed, credentialId } = yield* Deferred.await(deferred);

  const repoIds = new Set<string>();

  actions.forEach(Action.$match({
    Commit: ({repo}) => { repoIds.add(repo.id); },
    Push: ({repo}) => { repoIds.add(repo.id); },
    Pull: ({repo}) => { repoIds.add(repo.id); },
    Clone: ({repo}) => { repoIds.add(repo.id) },
    Setup: ({repos}) => {
      repos.map(repo => {
        repoIds.add(repo.id);
      });
    }
  }))
  const [signingKey, ...deployKeysEntries] = yield* Effect.all([
    effunct(getKey)(seed, `${FUTURE_TOOL_NAME}-signing-key-v1`),
    ...Array.from(repoIds).map(Effect.fn(function*(repoId) {
      return [
        repoId,
        yield* getKey(seed, `${FUTURE_TOOL_NAME}-deploy-key-v1:${repoId}`)
      ] as [string, SSHKey];
    }))    
  ]);
  const deployKeys = Object.fromEntries(deployKeysEntries);
  return { signingKey, credentialId, deployKeys };
}