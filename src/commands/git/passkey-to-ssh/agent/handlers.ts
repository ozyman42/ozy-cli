import { Effect } from "effect";
import { AgentRpcGroup } from "./group";
import { agentModules } from "../../../../modules/agent-modules";
import { CURRENT_VERSION } from "../../../../common/constants";

export const handlersLayer = AgentRpcGroup.toLayer({
  GetVersion: () => Effect.succeed({ version: CURRENT_VERSION }),
  DeclareSession: (payload) => Effect.gen(function* () {
    const session = yield* agentModules.Session;
    return yield* session.startSession(payload);
  }),
});
