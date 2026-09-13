import crypto from "node:crypto";
import express, { NextFunction, Request, Response } from "express";
import { makeStore, type Store, type Transfer, type Wallet } from "./store/index.js";
import { latency, logger, registry, requests } from "./telemetry.js";

const app = express();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required (e.g. postgres://wallet:wallet@localhost:5432/wallet)");
}

const store: Store = makeStore({ connectionString });

const outputWallet = (r: Wallet) => ({
  id: r.id,
  balance_paise: r.balance_paise,
});

const outputTransfer = (r: Transfer) => ({
  id: r.id,
  from: r.from_wallet_id,
  to: r.to_wallet_id,
  amount_paise: r.amount_paise,
  status: r.status,
  ...(r.reversal_of_id ? { reversal_of: r.reversal_of_id } : {}),
});

function token(req: Request) {
  const v = req.header("authorization");
  if (!v?.startsWith("Bearer ") || v.length === 7) {
    throw Object.assign(new Error("bearer token required"), { status: 401 });
  }
  return v.slice(7);
}

function validAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

app.use(express.json());

app.use((req, res, next) => {
  const correlationId = req.header("x-correlation-id") ?? crypto.randomUUID();
  const start = process.hrtime.bigint();
  res.setHeader("x-correlation-id", correlationId);
  res.locals.correlationId = correlationId;
  res.on("finish", () => {
    const route = req.route?.path ?? req.path;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    requests.inc({ method: req.method, route, status: String(res.statusCode) });
    latency.observe({ method: req.method, route }, seconds);
    logger.info(
      {
        correlationId,
        method: req.method,
        route,
        status: res.statusCode,
        duration_ms: Math.round(seconds * 1000),
      },
      "request complete",
    );
  });
  next();
});

app.post("/wallets", async (req, res, next) => {
  try {
    const owner = token(req);
    const row = await store.getOrCreateWallet(owner);
    return res.status(201).json(outputWallet(row));
  } catch (e) {
    next(e);
  }
});

app.get("/wallets/:id", async (req, res, next) => {
  try {
    const owner = token(req);
    const row = await store.getWallet(req.params.id);
    if (!row) {
      return res.status(404).json({ error: "wallet not found" });
    }
    if (row.owner_token !== owner) {
      return res
        .status(403)
        .json({ error: "wallet belongs to another user" });
    }
    return res.json(outputWallet(row));
  } catch (e) {
    next(e);
  }
});

app.post("/transfers", async (req, res, next) => {
  try {
    const owner = token(req);
    const { from, to, amount_paise: amount, idempotency_key: key } =
      req.body ?? {};
    if (
      typeof from !== "string" ||
      typeof to !== "string" ||
      from === to ||
      typeof key !== "string" ||
      !key ||
      !validAmount(amount)
    ) {
      return res.status(400).json({ error: "invalid transfer body" });
    }
    const row = await store.transfer(
      owner,
      from,
      to,
      amount,
      key,
      res.locals.correlationId,
    );
    return res
      .status(row.status === "declined" ? 422 : 201)
      .json(outputTransfer(row));
  } catch (e) {
    next(e);
  }
});

app.post("/transfers/:id/reverse", async (req, res, next) => {
  try {
    const owner = token(req);
    const { idempotency_key: key } = req.body ?? {};
    if (typeof key !== "string" || !key) {
      return res.status(400).json({ error: "invalid reversal body" });
    }
    const row = await store.reverse(
      owner,
      req.params.id,
      key,
      res.locals.correlationId,
    );
    return res
      .status(row.status === "declined" ? 422 : 201)
      .json(outputTransfer(row));
  } catch (e) {
    next(e);
  }
});

app.get("/transfers/:id", async (req, res, next) => {
  try {
    const owner = token(req);
    const row = await store.getTransferWithOwners(req.params.id);
    if (!row) {
      return res.status(404).json({ error: "transfer not found" });
    }
    if (row.from_owner !== owner && row.to_owner !== owner) {
      return res
        .status(403)
        .json({ error: "transfer belongs to another user" });
    }
    return res.json(outputTransfer(row));
  } catch (e) {
    next(e);
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = error.status ?? 500;
  logger.error(
    { err: error.message, correlationId: res.locals.correlationId },
    "request failed",
  );
  res.status(status).json({
    error: status === 500 ? "internal error" : error.message,
  });
});

async function main() {
  await store.init();
  app.listen(Number(process.env.PORT ?? 3000), () =>
    logger.info({ port: process.env.PORT ?? 3000 }, "wallet service listening"),
  );
}

main().catch((e) => {
  logger.error({ err: e }, "fatal: failed to start");
  process.exit(1);
});