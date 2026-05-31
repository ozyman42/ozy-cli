import { Effect, Layer, pipe, Data, FileSystem, Schedule } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { AgentRpcGroup } from "../../commands/git/passkey-to-ssh/agent/group";
import { modules } from "../cli-modules";
import type { AgentRpcClient, IAgentClient } from "./interface";
import { AGENT_CMD_PATH, AGENT_LOG_FILE_PATH, AGENT_PID_FILE_PATH, AGENT_PORT, CURRENT_VERSION } from "../../common/constants";
import { log } from "../../common/log";
import { openSync } from "node:fs";

const agentClientLayer = pipe(
  RpcClient.layerProtocolHttp({ url: `http://localhost:${AGENT_PORT}/rpc` }),
  Layer.provideMerge(RpcSerialization.layerJson),
  Layer.provideMerge(FetchHttpClient.layer)
);

class NoResponseError extends Data.TaggedError("NoResponseError")<{}> {
  public toString() {
    return "No response from agent.";
  }
}
class NonMatchingVersionError extends Data.TaggedError("NonMatchingVersionError")<{
  cliVersion: string;
  agentVersion: string;
}> {
  public toString() {
    return `Agent running but with mismatched version ${this.agentVersion} compared to CLI version ${this.cliVersion}`;
  }
}

type PingError = NoResponseError | NonMatchingVersionError;

export class AgentClientImpl extends implementing(modules.AgentClient).uses(FileSystem.FileSystem) implements IAgentClient {
  *usingClient<A, E>(use: (client: AgentRpcClient) => EffectGen<A, E>): EffectGen<A, E> {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(AgentRpcGroup);
        return yield* use(client);
      })
    ).pipe(Effect.provide(agentClientLayer));
  }

  private *ping(): EffectGen<{running: true}, PingError> {
    return yield* this.usingClient(function* (client): EffectGen<{running: true}, PingError> {
      const { version } = yield* pipe(
        client.GetVersion({}),
        Effect.catchTag("RpcClientError", () => new NoResponseError())
      );
      if (version !== CURRENT_VERSION)
        return yield* new NonMatchingVersionError({
          cliVersion: CURRENT_VERSION,
          agentVersion: version
        });
      return {running: true};
    });
  }

  private *killAgent(): EffectGen<void, string> {
    const pidFileContents = yield* pipe(
      this.getDependency(FileSystem.FileSystem).readFile(AGENT_PID_FILE_PATH),
      Effect.catchTag("PlatformError", err => Effect.fail(`${err.name}: ${err.message}`))
    );
    const PID = parseInt(pidFileContents.toString());
    log(`Killing agent on PID ${PID}`);
    process.kill(PID, "SIGTERM");
    yield* Effect.sleep(500);
  }

  private *waitForListening(): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const readLog = pipe(
      fs.readFileString(AGENT_LOG_FILE_PATH),
      Effect.catchTag("PlatformError", () => Effect.succeed(""))
    );
    yield* pipe(
      Effect.retry(
        pipe(
          readLog,
          Effect.flatMap(content =>
            content.includes("Listening on")
              ? Effect.void
              : Effect.fail("not listening yet")
          )
        ),
        Schedule.spaced("50 millis")
      ),
      Effect.timeout("5 seconds"),
      Effect.mapError(() => "Agent did not start within 5 seconds")
    );
  }

  private *startAgent(): EffectGen<void, string | PingError> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const logFile = openSync(AGENT_LOG_FILE_PATH, "w");
    const proc = Bun.spawn([AGENT_CMD_PATH], { stdout: logFile, stderr: logFile });
    yield* pipe(
      fs.writeFileString(AGENT_PID_FILE_PATH, proc.pid.toString()),
      Effect.catchTag("PlatformError", err => Effect.fail(`${err.name}: ${err.message}`))
    );
    yield* effunct(this.waitForListening)();
    yield* this.ping();
    log(`Started agent at PID ${proc.pid}`);
  }

  *killIfRunning(): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const pidExists = yield* pipe(
      fs.exists(AGENT_PID_FILE_PATH),
      Effect.catchTag("PlatformError", () => Effect.succeed(false))
    );
    if (pidExists) yield* effunct(this.killAgent)();
  }

  *ensureRunning(): EffectGen<void, string> {
    const { killAgent } = this;
    const {running} = yield* pipe(
      effunct(this.ping)(),
      Effect.catchTag("NonMatchingVersionError", Effect.fn(function*(err) {
        log(err.toString());
        yield* killAgent();
        return {running: false};
      })),
      Effect.catchTag("NoResponseError", Effect.fn(function*(err) {
        log(err.toString());
        return {running: false};
      }))
    );
    if (!running) {
      yield* pipe(
        effunct(this.startAgent)(),
        Effect.mapError(err => 
          typeof err === "string" ? 
            err :
            `Failed to start agent due to ${err.name}: ${err.toString()}`
        )
      );
    }
  }
}
