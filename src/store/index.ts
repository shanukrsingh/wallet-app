import type { Store } from "./base.js";
import { PostgresStore } from "./postgres.js";

export function makeStore(opts: { connectionString: string }): Store {
  return new PostgresStore(opts.connectionString);
}

export type { Store, Transfer, TransferWithOwners, Wallet } from "./base.js";
export { HttpError } from "./base.js";