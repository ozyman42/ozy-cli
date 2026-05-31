import { type EffectGen } from "effective-modules";
import { type Context, Effect } from "effect";

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
