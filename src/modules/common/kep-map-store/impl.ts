import { Effect, Option, pipe } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { commonModules } from "..";
import { type IKeyMapStore } from "./interface";
import { SSHPubkey, CredentialId } from "@/modules/common/crypto/impl";
import { CRED_ID_COMMENT_PREFIX, FUTURE_TOOL_NAME } from "@/common/constants";

export class KeyMapStoreImpl extends implementing(commonModules.KeyMapStore).uses(commonModules.SSHConfig) implements IKeyMapStore {
  private *listToolPubkeyFiles(): EffectGen<{name: string, content: string}[], string> {
    const files = yield* effunct(this.dependencies.SSHConfig.listPubkeyFiles)();
    return files.filter(f => f.name.startsWith(`${FUTURE_TOOL_NAME}-`));
  }

  *listPubkeys(): EffectGen<SSHPubkey[], string> {
    const files = yield* effunct(this.listToolPubkeyFiles)();
    return files.map(({ content }) => {
      const pubkeyAuth = content.split(' ').slice(0, 2).join(' ');
      return SSHPubkey.fromAuthorizedKey(pubkeyAuth);
    });
  }

  *getCredentialByPubkey(pubkey: SSHPubkey): EffectGen<Option.Option<string>, string> {
    const files = yield* effunct(this.listToolPubkeyFiles)();
    const match = files.find(({ content }) => {
      const pubkeyAuth = content.split(' ').slice(0, 2).join(' ');
      return pubkeyAuth === pubkey.authorizedKey;
    });
    if (!match) return Option.none();
    const parts = match.content.split(' ');
    const comment = parts[2];
    if (!comment || !comment.startsWith(CRED_ID_COMMENT_PREFIX))
      return yield* Effect.fail(`InvalidPubkeyFileError: file for pubkey ${pubkey.authorizedKey} has no valid credentialId comment`);
    return Option.some(comment.slice(CRED_ID_COMMENT_PREFIX.length));
  }

  *addKey(pubkey: SSHPubkey, credentialId: string): EffectGen<void, string> {
    const name = new CredentialId(credentialId).humanReadableName;
    yield* pipe(
      effunct(this.dependencies.SSHConfig.writePubkey)({
        name,
        comment: Option.some(`${CRED_ID_COMMENT_PREFIX}${credentialId}`),
        pubkey,
      }),
      Effect.asVoid
    );
  }
}
