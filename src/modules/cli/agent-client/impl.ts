import { Effect, Layer, Match, Option, pipe, Data, FileSystem, Schedule, Result } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { FetchHttpClient } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { AgentRpcGroup } from "@/modules/ssh-agent/session/interface-rpc";
import { cliModules } from "..";
import { type AgentRpcClient, type IAgentClient, AgentClientError } from "./interface";
import { AGENT_CMD_PATH, AGENT_PID_FILE_PATH, AGENT_PORT_FILE_PATH, AGENT_SOCK_FILE_PATH, CURRENT_VERSION } from "@/common/constants";
import { readFileSync, rmSync } from "node:fs";
import { log } from "@/common/log";

function makeAgentClientLayer(port: number) {
  return pipe(
    RpcClient.layerProtocolHttp({ url: `http://localhost:${port}/rpc` }),
    Layer.provideMerge(RpcSerialization.layerJson),
    Layer.provideMerge(FetchHttpClient.layer)
  );
}

class NoResponseError extends Data.TaggedError("NoResponseError")<{}> {
  public toString() { return "No response from agent."; }
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

export class AgentClientImpl extends implementing(cliModules.AgentClient).uses(FileSystem.FileSystem) implements IAgentClient {
  private *readPortFromFile(): EffectGen<Option.Option<number>, never> {
    const result = yield* pipe(
      this.getDependency(FileSystem.FileSystem).readFileString(AGENT_PORT_FILE_PATH),
      Effect.result
    );
    if (Result.isFailure(result)) return Option.none();
    const port = parseInt(result.success.trim());
    if (isNaN(port) || port <= 0 || port > 65535) {
      log(`Read out of bounds port ${port}`);
      return Option.none();
    }
    return Option.some(port);
  }

  private *pingAtPort(port: number): EffectGen<void, PingError> {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(AgentRpcGroup);
        const { version } = yield* pipe(
          client.GetVersion({}),
          Effect.catchTag("RpcClientError", () => new NoResponseError())
        );
        if (version !== CURRENT_VERSION)
          yield* new NonMatchingVersionError({ cliVersion: CURRENT_VERSION, agentVersion: version });
      })
    ).pipe(Effect.provide(makeAgentClientLayer(port)));
  }

  private *ping(): EffectGen<{ port: number }, PingError> {
    const portOption = yield* effunct(this.readPortFromFile)();
    if (Option.isNone(portOption)) return yield* new NoResponseError();
    const port = portOption.value;
    yield* effunct(this.pingAtPort)(port);
    return { port };
  }

  private *waitForPidFile(expectedPid: number): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    yield* pipe(
      Effect.retry(
        pipe(
          fs.readFileString(AGENT_PID_FILE_PATH),
          Effect.catchTag("PlatformError", () => Effect.fail("pid file not yet written")),
          Effect.flatMap(content => {
            const pid = parseInt(content.trim());
            return pid === expectedPid
              ? Effect.void
              : Effect.fail(`PID mismatch: expected ${expectedPid}, got ${pid}`);
          })
        ),
        Schedule.spaced("50 millis")
      ),
      Effect.timeout("5 seconds"),
      Effect.mapError(() => "Agent did not start within 5 seconds")
    );
  }

  private *startAgent(): EffectGen<{ pid: number; port: number }, string | PingError> {
    const proc = Bun.spawn([AGENT_CMD_PATH], { stdout: "ignore", stderr: "ignore" });
    yield* effunct(this.waitForPidFile)(proc.pid);
    const { port } = yield* effunct(this.ping)();
    log(`Started agent at PID ${proc.pid}`);
    return { pid: proc.pid, port };
  }

  *killIfRunning(): EffectGen<void, string> {
    try {
      // Throws if file missing
      const pidFileContent = readFileSync(AGENT_PID_FILE_PATH, "utf-8");
      const PID = parseInt(pidFileContent.trim());
      // If doesn't exist, below line throws
      process.kill(PID, 0);
      log(`Killing agent on PID ${PID}`);
      process.kill(PID, "SIGTERM");
      yield* Effect.sleep(500);
    } catch { }
    try { rmSync(AGENT_PID_FILE_PATH); } catch {}
    try { rmSync(AGENT_PORT_FILE_PATH); } catch {}
    try { rmSync(AGENT_SOCK_FILE_PATH); } catch {}
  }

  private *ensureRunning(): EffectGen<{ port: number }, string> {
    const pingResult = yield* pipe(effunct(this.ping)(), Effect.result);
    if (Result.isSuccess(pingResult)) return pingResult.success;
    log(pingResult.failure.toString());
    yield* Match.value(pingResult.failure).pipe(
      Match.tag("NonMatchingVersionError", () => effunct(this.killIfRunning)()),
      Match.tag("NoResponseError", () => effunct(this.killIfRunning)()),
      Match.exhaustive
    );
    return yield* pipe(
      effunct(this.startAgent)(),
      Effect.mapError(err =>
        typeof err === "string" ?
          err :
          `Failed to start agent due to ${err.name}: ${err.toString()}`
      )
    );
  }

  *usingClient<A, E>(use: (client: AgentRpcClient) => EffectGen<A, E>): EffectGen<A, AgentClientError<E>> {
    const { port } = yield* pipe(
      effunct(this.ensureRunning)(),
      Effect.mapError(reason => new AgentClientError.ClientError({ reason }))
    );
    return yield* pipe(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(AgentRpcGroup);
          return yield* use(client);
        })
      ),
      Effect.provide(makeAgentClientLayer(port)),
      Effect.mapError(e => new AgentClientError.UsageError({ cause: e }))
    );
  }
}
