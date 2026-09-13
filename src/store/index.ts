import type { Store } from "./base.js";
import { PostgresStore } from "./postgres.js";
import { SQLiteStore } from "./sqlite.js";

export function makeStore(opts: {
  connectionString?: string;
  sqlitePath?: string;
}): Store {
  if (opts.connectionString) {
    return new PostgresStore(opts.connectionString);
  }
  return new SQLiteStore(opts.sqlitePath ?? "wallet.sqlite");
}

export type { Store, Transfer, TransferWithOwners, Wallet } from "./base.js";
export { HttpError } from "./base.js";