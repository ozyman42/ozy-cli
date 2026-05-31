import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { RpcServer, RpcSerialization } from "effect/unstable/rpc";
import { BunHttpServer } from "@effect/platform-bun";
import { AgentRpcGroup } from "../commands/git/passkey-to-ssh/agent/group";
import { handlersLayer } from "../commands/git/passkey-to-ssh/agent/handlers";
import { sshAgentServerLayer } from "../commands/git/passkey-to-ssh/agent/ssh-agent-server";
import { AGENT_PORT } from "../common/constants";
import { OSPlatformImpl } from "../modules/os-platform/impl";
import { SSHAgentImpl } from "../modules/ssh-agent/impl";
import { SessionImpl } from "../modules/session/impl";

// Self-contained layers: each has its own deps satisfied internally
const sessionLayer = SessionImpl.Layer.pipe(Layer.provide(OSPlatformImpl.Layer));
const sshAgentLayer = SSHAgentImpl.Layer.pipe(Layer.provide(sessionLayer));

const appLayer = RpcServer.layerHttp({ group: AgentRpcGroup, path: "/rpc", protocol: "http" }).pipe(
  Layer.provide(
    Layer.mergeAll(
      RpcSerialization.layerJson,
      handlersLayer,
      sshAgentServerLayer,
    ).pipe(
      Layer.provide(Layer.mergeAll(
        OSPlatformImpl.Layer, // for sshAgentServerLayer
        sessionLayer,         // for handlersLayer
        sshAgentLayer,        // for sshAgentServerLayer
      ))
    )
  )
);

const serverLayer = HttpRouter.serve(appLayer).pipe(
  Layer.provide(BunHttpServer.layer({ port: AGENT_PORT }))
);

Effect.runPromise(Layer.launch(serverLayer));
