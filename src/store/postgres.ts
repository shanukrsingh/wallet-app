import crypto from "node:crypto";
import { Pool, types as pgTypes, type PoolClient } from "pg";
import { events, logger } from "../telemetry.js";
import {
  HttpError,
  isUniqueViolationPg,
  isInvalidUuidPg,
  type Store,
  type Transfer,
  type TransferStatus,
  type TransferWithOwners,
  type Wallet,
} from "./base.js";

export class PostgresStore implements Store {
  private pool: Pool;

  constructor(connectionString: string) {
    pgTypes.setTypeParser(20, (v: string) => Number(v));
    this.pool = new Pool({ connectionString, max: 20 });
  }

  async init(): Promise<void> {
    const schema = `
      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        owner_token TEXT NOT NULL UNIQUE,
        balance_paise BIGINT NOT NULL DEFAULT 100000 CHECK (balance_paise >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS transfers (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        from_wallet_id TEXT NOT NULL REFERENCES wallets(id),
        to_wallet_id TEXT NOT NULL REFERENCES wallets(id),
        amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
        status TEXT NOT NULL CHECK (status IN ('completed', 'declined')),
        reversal_of_id TEXT REFERENCES transfers(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (from_wallet_id <> to_wallet_id)
      );
    `;
    for (let attempt = 1; ; attempt++) {
      try {
        await this.pool.query(schema);
        break;
      } catch (e) {
        if (attempt >= 30) {
          throw e;
        }
        logger.warn({ attempt }, "waiting for database");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const idType = await this.pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'transfers' AND column_name = 'id'`,
    );
    const reversalType = idType.rows[0]?.data_type === "uuid" ? "UUID" : "TEXT";
    await this.pool.query(
      `ALTER TABLE transfers ADD COLUMN IF NOT EXISTS reversal_of_id ${reversalType} REFERENCES transfers(id)`,
    );
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_reversal ON transfers(reversal_of_id) WHERE reversal_of_id IS NOT NULL`,
    );
  }

  async getOrCreateWallet(owner: string): Promise<Wallet> {
    await this.pool.query(
      "INSERT INTO wallets(id, owner_token) VALUES($1, $2) ON CONFLICT (owner_token) DO NOTHING",
      [crypto.randomUUID(), owner],
    );
    const { rows } = await this.pool.query(
      `SELECT id, owner_token, balance_paise FROM wallets WHERE owner_token = $1`,
      [owner],
    );
    return rows[0] as Wallet;
  }

  async getWallet(id: string): Promise<Wallet | undefined> {
    return this.queryRow<Wallet>(
      `SELECT id, owner_token, balance_paise FROM wallets WHERE id = $1`,
      [id],
    );
  }

  async getTransfer(id: string): Promise<Transfer | undefined> {
    return this.queryRow<Transfer>(
      `SELECT * FROM transfers WHERE id = $1`,
      [id],
    );
  }

  async getTransferWithOwners(
    id: string,
  ): Promise<TransferWithOwners | undefined> {
    return this.queryRow<TransferWithOwners>(
      `SELECT t.id, t.idempotency_key, t.from_wallet_id, t.to_wallet_id, t.amount_paise, t.status, t.reversal_of_id,
              wf.owner_token AS from_owner, wt.owner_token AS to_owner
       FROM transfers t
       JOIN wallets wf ON wf.id = t.from_wallet_id
       JOIN wallets wt ON wt.id = t.to_wallet_id
       WHERE t.id = $1`,
      [id],
    );
  }

  private async getTransferByKey(key: string): Promise<Transfer | undefined> {
    return this.queryRow<Transfer>(
      `SELECT * FROM transfers WHERE idempotency_key = $1`,
      [key],
    );
  }

  private async queryRow<T>(
    sql: string,
    params?: unknown[],
    db: Pool | PoolClient = this.pool,
  ): Promise<T | undefined> {
    try {
      const { rows } = await db.query(sql, params);
      return rows[0] as T | undefined;
    } catch (e) {
      if (isInvalidUuidPg(e)) return undefined;
      throw e;
    }
  }

  private async lockWallets(
    client: PoolClient,
    ids: string[],
  ): Promise<Map<string, Wallet>> {
    const locked = new Map<string, Wallet>();
    for (const wid of ids.slice().sort()) {
      let r;
      try {
        r = await client.query(
          `SELECT id, owner_token, balance_paise FROM wallets WHERE id = $1 FOR UPDATE`,
          [wid],
        );
      } catch (e) {
        if (isInvalidUuidPg(e)) {
          throw new HttpError(404, "wallet not found");
        }
        throw e;
      }
      if (r.rows.length === 0) {
        throw new HttpError(404, "wallet not found");
      }
      locked.set(wid, r.rows[0] as Wallet);
    }
    return locked;
  }

  async transfer(
    owner: string,
    from: string,
    to: string,
    amount: number,
    key: string,
    correlationId: string,
  ): Promise<Transfer> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const priorRes = await client.query(
        `SELECT * FROM transfers WHERE idempotency_key = $1`,
        [key],
      );
      if (priorRes.rows.length > 0) {
        const prior = priorRes.rows[0] as Transfer;
        if (
          prior.from_wallet_id !== from ||
          prior.to_wallet_id !== to ||
          prior.amount_paise !== amount
        ) {
          throw new HttpError(
            409,
            "idempotency key was reused with a different body",
          );
        }
        await client.query("COMMIT");
        events.inc({ event: "idempotent_replay" });
        logger.info(
          { correlationId, transferId: prior.id },
          "idempotent replay hit",
        );
        return prior;
      }

      const locked = await this.lockWallets(client, [from, to]);
      const source = locked.get(from)!;
      if (source.owner_token !== owner) {
        throw new HttpError(403, "cannot debit another user wallet");
      }

      const id = crypto.randomUUID();
      const debit = await client.query(
        `UPDATE wallets SET balance_paise = balance_paise - $1 WHERE id = $2 AND balance_paise >= $1`,
        [amount, from],
      );
      const status: TransferStatus =
        debit.rowCount === 1 ? "completed" : "declined";

      if (status === "completed") {
        await client.query(
          `UPDATE wallets SET balance_paise = balance_paise + $1 WHERE id = $2`,
          [amount, to],
        );
        events.inc({ event: "created" });
        logger.info({ correlationId, transferId: id }, "transfer completed");
      } else {
        events.inc({ event: "declined_insufficient_funds" });
        logger.info({ correlationId, transferId: id }, "transfer declined");
      }

      await client.query(
        `INSERT INTO transfers(id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status, reversal_of_id)
         VALUES($1, $2, $3, $4, $5, $6, NULL)`,
        [id, key, from, to, amount, status],
      );

      await client.query("COMMIT");
      return {
        id,
        idempotency_key: key,
        from_wallet_id: from,
        to_wallet_id: to,
        amount_paise: amount,
        status,
        reversal_of_id: null,
      } satisfies Transfer;
    } catch (e) {
      await this.rollbackQuietly(client);
      if (isUniqueViolationPg(e)) {
        return this.settleTransferRace(e, from, to, amount, key, correlationId);
      }
      throw e;
    } finally {
      client.release();
    }
  }

  private async settleTransferRace(
    originalError: unknown,
    from: string,
    to: string,
    amount: number,
    key: string,
    correlationId: string,
  ): Promise<Transfer> {
    const prior = await this.getTransferByKey(key);
    if (prior) {
      if (
        prior.from_wallet_id !== from ||
        prior.to_wallet_id !== to ||
        prior.amount_paise !== amount
      ) {
        throw new HttpError(
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
    throw originalError;
  }

  async reverse(
    owner: string,
    originalId: string,
    key: string,
    correlationId: string,
  ): Promise<Transfer> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const priorRes = await client.query(
        `SELECT * FROM transfers WHERE idempotency_key = $1`,
        [key],
      );
      if (priorRes.rows.length > 0) {
        const prior = priorRes.rows[0] as Transfer;
        if (prior.reversal_of_id !== originalId) {
          throw new HttpError(
            409,
            "idempotency key was reused with a different body",
          );
        }
        await client.query("COMMIT");
        events.inc({ event: "idempotent_replay" });
        logger.info(
          { correlationId, transferId: prior.id },
          "idempotent replay hit",
        );
        return prior;
      }

      const original = await this.queryRow<Transfer>(
        `SELECT * FROM transfers WHERE id = $1`,
        [originalId],
        client,
      );
      if (!original) {
        throw new HttpError(404, "transfer not found");
      }
      if (original.reversal_of_id) {
        throw new HttpError(409, "a reversal cannot itself be reversed");
      }
      const existing = await this.queryRow<Transfer>(
        `SELECT * FROM transfers WHERE reversal_of_id = $1`,
        [originalId],
        client,
      );
      if (existing) {
        throw new HttpError(409, "transfer already reversed");
      }
      if (original.status !== "completed") {
        throw new HttpError(409, "only completed transfers can be reversed");
      }

      const locked = await this.lockWallets(client, [
        original.to_wallet_id,
        original.from_wallet_id,
      ]);
      const fromWallet = locked.get(original.to_wallet_id)!;
      const toWallet = locked.get(original.from_wallet_id)!;
      if (fromWallet.owner_token !== owner && toWallet.owner_token !== owner) {
        throw new HttpError(403, "caller must be a party to the transfer");
      }

      const id = crypto.randomUUID();
      const debit = await client.query(
        `UPDATE wallets SET balance_paise = balance_paise - $1 WHERE id = $2 AND balance_paise >= $1`,
        [original.amount_paise, original.to_wallet_id],
      );
      const status: TransferStatus =
        debit.rowCount === 1 ? "completed" : "declined";

      if (status === "completed") {
        await client.query(
          `UPDATE wallets SET balance_paise = balance_paise + $1 WHERE id = $2`,
          [original.amount_paise, original.from_wallet_id],
        );
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

      await client.query(
        `INSERT INTO transfers(id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status, reversal_of_id)
         VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          key,
          original.to_wallet_id,
          original.from_wallet_id,
          original.amount_paise,
          status,
          originalId,
        ],
      );

      await client.query("COMMIT");
      return {
        id,
        idempotency_key: key,
        from_wallet_id: original.to_wallet_id,
        to_wallet_id: original.from_wallet_id,
        amount_paise: original.amount_paise,
        status,
        reversal_of_id: originalId,
      } satisfies Transfer;
    } catch (e) {
      await this.rollbackQuietly(client);
      if (isUniqueViolationPg(e)) {
        return this.settleReverseRace(e, owner, originalId, key, correlationId);
      }
      throw e;
    } finally {
      client.release();
    }
  }

  private async settleReverseRace(
    originalError: unknown,
    owner: string,
    originalId: string,
    key: string,
    correlationId: string,
  ): Promise<Transfer> {
    const prior = await this.getTransferByKey(key);
    if (prior) {
      if (prior.reversal_of_id !== originalId) {
        throw new HttpError(
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
    const original = await this.queryRow<Transfer>(
      `SELECT * FROM transfers WHERE id = $1`,
      [originalId],
    );
    if (!original) {
      throw originalError;
    }
    const existing = await this.queryRow<Transfer>(
      `SELECT * FROM transfers WHERE reversal_of_id = $1`,
      [originalId],
    );
    if (existing) {
      throw new HttpError(409, "transfer already reversed");
    }
    throw originalError;
  }

  private async rollbackQuietly(client: PoolClient) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
  }
}