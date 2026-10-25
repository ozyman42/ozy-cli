import { type EffectGen } from "effective-modules";
import { type Context, Effect, Logger } from "effect";
import { test as buntest } from "bun:test";

export function test(property: string, effectfulFn: () => EffectGen<void, any, never>) {
  buntest(property, async () => {
    await Effect.runPromise(Effect.fn(effectfulFn)());
  })
}

type MethodsRequireSelf<S extends Context.Service<any, any>> = {
  [k in keyof S["Service"]]: 
    S["Service"][k] extends Function ?
      ReturnType<S["Service"][k]> extends EffectGen<infer A, infer E, infer R> ?
        (...args: Parameters<S["Service"][k]>) => Effect.Effect<A, E, R | S["Identifier"]>
        : ReturnType<S["Service"][k]> extends Effect.Effect<infer A, infer E, infer R> ?
          (...args: Parameters<S["Service"][k]>) => Effect.Effect<A, E, R | S["Identifier"]>
          : never
      : never;
}

export function using<S extends Context.Service<any, any>>(service: S): MethodsRequireSelf<S> {
  return new Proxy({}, {
    get(_target, prop, _receiver) {
      return Effect.fn(function*(...args: any[]) {
        const instance = yield* service;
        return yield* instance[prop](...args);
      })
    }
  }) as any;
}

const pureLogger = Logger.make<unknown, unknown>(({ message }) => message);
export const pureLoggerLayer = Logger.layer([Logger.withLeveledConsole(pureLogger)]);