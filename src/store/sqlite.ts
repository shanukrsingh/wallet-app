import crypto from "node:crypto";
import Database from "better-sqlite3";
import { events, logger } from "../telemetry.js";
import {
  errStatus,
  isUniqueViolationSqlite,
  type Store,
  type Transfer,
  type TransferStatus,
  type TransferWithOwners,
  type Wallet,
} from "./base.js";

export class SQLiteStore implements Store {
  private db: Database.Database;
  private executeTransfer: (
    owner: string,
    from: string,
    to: string,
    amount: number,
    key: string,
    correlationId: string,
  ) => Transfer;
  private executeReverse: (
    owner: string,
    originalId: string,
    key: string,
    correlationId: string,
  ) => Transfer;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.executeTransfer = this.db.transaction(
      (owner, from, to, amount, key, correlationId): Transfer => {
        const prior = this.getTransferByKey(key);
        if (prior) {
          if (
            prior.from_wallet_id !== from ||
            prior.to_wallet_id !== to ||
            prior.amount_paise !== amount
          ) {
            throw errStatus(
              409,
              "idempotency key was reused with a different body",
            );
          }
          events.inc({ event: "idempotent_replay" });
          logger.info(
            { correlationId, transferId: prior.id },
            "idempotent replay hit",
          );
          return prior;
        }

        const source = this.getWalletById(from);
        const destination = this.getWalletById(to);
        if (!source || !destination) {
          throw errStatus(404, "wallet not found");
        }
        if (source.owner_token !== owner) {
          throw errStatus(403, "cannot debit another user wallet");
        }

        const id = crypto.randomUUID();
        const debit = this.db
          .prepare(
            "UPDATE wallets SET balance_paise=balance_paise-? WHERE id=? AND balance_paise>=?",
          )
          .run(amount, from, amount);
        const status: TransferStatus =
          debit.changes === 1 ? "completed" : "declined";

        if (status === "completed") {
          this.db
            .prepare("UPDATE wallets SET balance_paise=balance_paise+? WHERE id=?")
            .run(amount, to);
          events.inc({ event: "created" });
          logger.info({ correlationId, transferId: id }, "transfer completed");
        } else {
          events.inc({ event: "declined_insufficient_funds" });
          logger.info({ correlationId, transferId: id }, "transfer declined");
        }

        this.db
          .prepare(
            "INSERT INTO transfers(id,idempotency_key,from_wallet_id,to_wallet_id,amount_paise,status,reversal_of_id) VALUES(?,?,?,?,?,?,?)",
          )
          .run(id, key, from, to, amount, status, null);

        return {
          id,
          idempotency_key: key,
          from_wallet_id: from,
          to_wallet_id: to,
          amount_paise: amount,
          status,
          reversal_of_id: null,
        } satisfies Transfer;
      },
    );
    this.executeReverse = this.db.transaction(
      (owner, originalId, key, correlationId): Transfer => {
        const prior = this.getTransferByKey(key);
        if (prior) {
          if (prior.reversal_of_id !== originalId) {
            throw errStatus(
              409,
              "idempotency key was reused with a different body",
            );
          }
          events.inc({ event: "idempotent_replay" });
          logger.info(
            { correlationId, transferId: prior.id },
            "idempotent replay hit",
          );
          return prior;
        }

        const original = this.getTransferById(originalId);
        if (!original) {
          throw errStatus(404, "transfer not found");
        }
        if (original.reversal_of_id) {
          throw errStatus(409, "a reversal cannot itself be reversed");
        }
        const existingReversal = this.db
          .prepare("SELECT * FROM transfers WHERE reversal_of_id=?")
          .get(originalId) as Transfer | undefined;
        if (existingReversal) {
          throw errStatus(409, "transfer already reversed");
        }
        if (original.status !== "completed") {
          throw errStatus(409, "only completed transfers can be reversed");
        }
        const fromWallet = this.getWalletById(original.to_wallet_id);
        const toWallet = this.getWalletById(original.from_wallet_id);
        if (!fromWallet || !toWallet) {
          throw errStatus(404, "wallet not found");
        }
        if (
          fromWallet.owner_token !== owner &&
          toWallet.owner_token !== owner
        ) {
          throw errStatus(403, "caller must be a party to the transfer");
        }

        const id = crypto.randomUUID();
        const debit = this.db
          .prepare(
            "UPDATE wallets SET balance_paise=balance_paise-? WHERE id=? AND balance_paise>=?",
          )
          .run(original.amount_paise, original.to_wallet_id, original.amount_paise);
        const status: TransferStatus =
          debit.changes === 1 ? "completed" : "declined";

        if (status === "completed") {
          this.db
            .prepare("UPDATE wallets SET balance_paise=balance_paise+? WHERE id=?")
            .run(original.amount_paise, original.from_wallet_id);
          events.inc({ event: "reversed" });
          logger.info(
            { correlationId, transferId: id, reversalOf: originalId },
            "reversal completed",
          );
        } else {
          events.inc({ event: "declined_insufficient_funds" });
          logger.info(
            { correlationId, transferId: id, reversalOf: originalId },
            "reversal declined",
          );
        }

        this.db
          .prepare(
            "INSERT INTO transfers(id,idempotency_key,from_wallet_id,to_wallet_id,amount_paise,status,reversal_of_id) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            key,
            original.to_wallet_id,
            original.from_wallet_id,
            original.amount_paise,
            status,
            originalId,
          );

        return {
          id,
          idempotency_key: key,
          from_wallet_id: original.to_wallet_id,
          to_wallet_id: original.from_wallet_id,
          amount_paise: original.amount_paise,
          status,
          reversal_of_id: originalId,
        } satisfies Transfer;
      },
    );
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        owner_token TEXT NOT NULL UNIQUE,
        balance_paise INTEGER NOT NULL DEFAULT 100000 CHECK(balance_paise >= 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        from_wallet_id TEXT NOT NULL REFERENCES wallets(id),
        to_wallet_id TEXT NOT NULL REFERENCES wallets(id),
        amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
        status TEXT NOT NULL CHECK(status IN ('completed', 'declined')),
        reversal_of_id TEXT REFERENCES transfers(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(from_wallet_id <> to_wallet_id)
      );
    `);
    {
      const cols = (
        this.db
          .prepare("SELECT name FROM pragma_table_info('transfers')")
          .all() as { name: string }[]
      ).map((c) => c.name);
      if (!cols.includes("reversal_of_id")) {
        this.db.exec(
          "ALTER TABLE transfers ADD COLUMN reversal_of_id TEXT REFERENCES transfers(id)",
        );
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_reversal ON transfers(reversal_of_id) WHERE reversal_of_id IS NOT NULL",
      );
    }
  }

  private getWalletById(id: string): Wallet | undefined {
    return this.db.prepare("SELECT * FROM wallets WHERE id=?").get(id) as
      | Wallet
      | undefined;
  }

  private getTransferById(id: string): Transfer | undefined {
    return this.db.prepare("SELECT * FROM transfers WHERE id=?").get(id) as
      | Transfer
      | undefined;
  }

  private getTransferByKey(key: string): Transfer | undefined {
    return this.db
      .prepare("SELECT * FROM transfers WHERE idempotency_key=?")
      .get(key) as Transfer | undefined;
  }

  async getOrCreateWallet(owner: string): Promise<Wallet> {
    this.db
      .prepare("INSERT OR IGNORE INTO wallets(id,owner_token) VALUES(?,?)")
      .run(crypto.randomUUID(), owner);
    const row = this.db
      .prepare("SELECT * FROM wallets WHERE owner_token=?")
      .get(owner) as Wallet;
    return row;
  }

  async getWallet(id: string): Promise<Wallet | undefined> {
    return this.getWalletById(id);
  }

  async getTransfer(id: string): Promise<Transfer | undefined> {
    return this.getTransferById(id);
  }

  async getTransferWithOwners(
    id: string,
  ): Promise<TransferWithOwners | undefined> {
    return this.db
      .prepare(
        "SELECT t.*, wf.owner_token AS from_owner, wt.owner_token AS to_owner FROM transfers t JOIN wallets wf ON wf.id=t.from_wallet_id JOIN wallets wt ON wt.id=t.to_wallet_id WHERE t.id=?",
      )
      .get(id) as TransferWithOwners | undefined;
  }

  async transfer(
    owner: string,
    from: string,
    to: string,
    amount: number,
    key: string,
    correlationId: string,
  ): Promise<Transfer> {
    try {
      return this.executeTransfer(owner, from, to, amount, key, correlationId);
    } catch (e) {
      if (isUniqueViolationSqlite(e)) {
        const prior = this.getTransferByKey(key);
        if (prior) {
          if (
            prior.from_wallet_id !== from ||
            prior.to_wallet_id !== to ||
            prior.amount_paise !== amount
          ) {
            throw errStatus(
              409,
              "idempotency key was reused with a different body",
            );
          }
          events.inc({ event: "idempotent_replay" });
          logger.info(
            { correlationId, transferId: prior.id },
            "idempotent replay hit",
          );
          return prior;
        }
      }
      throw e;
    }
  }

  async reverse(
    owner: string,
    originalId: string,
    key: string,
    correlationId: string,
  ): Promise<Transfer> {
    try {
      return this.executeReverse(owner, originalId, key, correlationId);
    } catch (e) {
      if (isUniqueViolationSqlite(e)) {
        const prior = this.getTransferByKey(key);
        if (prior) {
          if (prior.reversal_of_id !== originalId) {
            throw errStatus(
              409,
              "idempotency key was reused with a different body",
            );
          }
          events.inc({ event: "idempotent_replay" });
          logger.info(
            { correlationId, transferId: prior.id },
            "idempotent replay hit",
          );
          return prior;
        }
        const original = this.getTransferById(originalId);
        if (!original) {
          throw e;
        }
        const already = this.db
          .prepare("SELECT * FROM transfers WHERE reversal_of_id=?")
          .get(originalId) as Transfer | undefined;
        if (already) {
          throw errStatus(409, "transfer already reversed");
        }
      }
      throw e;
    }
  }
}