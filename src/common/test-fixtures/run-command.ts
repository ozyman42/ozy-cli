import { Effect } from "effect";
import { makeCommand } from "../command";

// Runs one makeCommand-built command whose action succeeds or fails, as chosen by argv[2].
const outcome = process.argv[2];
await makeCommand("fixture", "succeeds or fails on request", function* () {
  if (outcome === "fail") return yield* Effect.fail("requested failure");
}).parseAsync(["node", "fixture"]);
