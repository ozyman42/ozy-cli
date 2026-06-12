import { Effect, Option, pipe, Deferred, Scope, Data, Result } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { SessionError } from "./interface";
import { FUTURE_TOOL_NAME } from "@/common/constants";
import { randomUUID } from "node:crypto";
import { CredentialId } from "@/modules/common/crypto/impl";
import { useOrCreatePasskeyPage } from "./passkey-prf-page";
import { CommonModules, commonModules } from "@/modules/common";
import { log } from "@/common/log";
import { SSHKeyPair } from "@/modules/common/crypto/impl";
import type { ActiveSession } from "./impl";

type BrowserResult = {
  seed: Uint8Array;
  credentialId: CredentialId;
  cacheMinutes?: number;
};

export type PrfResult = {
  keyPair: SSHKeyPair;
  credentialId: CredentialId;
  cacheMinutes?: number;
};

export type PrfInput = Data.TaggedEnum<{
  DerivePubkeyOnly: {
    pubkey: Option.Option<string>;
    credentialId: Option.Option<string>;
    username: string;
  },
  DerivePubkeyForRequests: {
    session: ActiveSession
  }
}>
export const PrfInput = Data.taggedEnum<PrfInput>();

const TRANSPORT_KEY_CONTEXT = `${FUTURE_TOOL_NAME}-transport-v1`;

export function* prfFlow(input: PrfInput): EffectGen<PrfResult, SessionError, CommonModules.Crypto | CommonModules.OSPlatform | Scope.Scope> {
  const crypto = yield* commonModules.Crypto;
  const osPlatform = yield* commonModules.OSPlatform;

  const flowId = PrfInput.$match(input, {
    DerivePubkeyOnly: () => randomUUID(),
    DerivePubkeyForRequests: ({ session }) => session.id,
  });

  const agentKeyPair = yield* pipe(
    effunct(crypto.createECDHKey)(),
    Effect.catch(err => Effect.fail(SessionError.cases.InternalError.make({ reason: err })))
  );

  const challenge = yield* crypto.getRandomChallenge();
  const deferred = yield* Deferred.make<BrowserResult, SessionError>();

  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.searchParams.get("id") !== flowId) {
            return new Response("Forbidden", { status: 403 });
          }
          if (url.pathname === "/" && req.method === "GET") {
            return new Response(
              useOrCreatePasskeyPage({
                agentKeyPair, challenge, context: input,
                transportKeyContext: TRANSPORT_KEY_CONTEXT,
                username: PrfInput.$match(input, {
                  DerivePubkeyOnly: ({ username }) => username,
                  DerivePubkeyForRequests: () => '',
                }),
              }),
              { headers: { "Content-Type": "text/html; charset=utf-8" } }
            );
          }
          if (url.pathname === "/seed" && req.method === "POST") {
            try {
              const body = await req.json() as {
                encryptedSeed: string; iv: string;
                browserPublicKey: string; credentialId: string;
                cacheMinutes?: number;
              };
              Effect.runFork(Effect.gen(function* () {
                const innerResult = yield* Effect.result(Effect.gen(function* () {
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
                    cacheMinutes: body.cacheMinutes,
                  });
                  if (!completed) {
                    yield* Effect.fail(SessionError.cases.InternalError.make({
                      reason: 'Detected multiple POSTs to seed endpoint'
                    }));
                  }
                }));
                if (Result.isFailure(innerResult)) {
                  console.error('[/seed fork error]', innerResult.failure);
                  yield* Deferred.fail(deferred, SessionError.cases.InternalError.make({
                    reason: `Seed decryption failed: ${String(innerResult.failure)}`
                  }));
                }
              }));
              return new Response(JSON.stringify({ ok: true, friendlyName: CredentialId.fromBase64(body.credentialId).humanReadableName }), {
                headers: { "Content-Type": "application/json" },
              });
            } catch (e) {
              console.error("[/seed handler error]", e);
              Effect.runFork(Deferred.fail(deferred, SessionError.cases.InternalError.make({
                reason: (e as Error).toString()
              })));
              return new Response(JSON.stringify({ error: String(e) }), {
                status: 500, headers: { "Content-Type": "application/json" },
              });
            }
          }
          if (url.pathname === "/error" && req.method === "POST") {
            const body = await req.json() as { cancelled: boolean; message: string };
            const error = body.cancelled
              ? SessionError.cases.WebAuthnCancelled.make({})
              : SessionError.cases.InternalError.make({ reason: body.message });
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
  yield* osPlatform.openBrowserWindow(`http://localhost:${server.port}/?id=${flowId}`);

  const { seed, credentialId, cacheMinutes } = yield* Deferred.await(deferred);

  const keyPair = yield* pipe(
    SSHKeyPair.fromSeed(seed, `${FUTURE_TOOL_NAME}-key-v1`),
    Effect.mapError(reason => SessionError.cases.InternalError.make({ reason }))
  );
  return { keyPair, credentialId, cacheMinutes };
}
