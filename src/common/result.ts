export type Ok<T> =
  { success: true; value: T };

export type Err<E> =
  { success: false; error: E; reason: string; silent: boolean; }

export type Result<T, E> = Ok<T> | Err<E>;

export function Ok<T>(value: T): Ok<T> {
  return { success: true, value };
}

export function Err<E>(error: E, reason: string, silent = false): Err<E> {
  return { success: false, error, reason, silent };
}
