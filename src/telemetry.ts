import pino from "pino";
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const requests = new Counter({
  name: "http_requests_total",
  help: "HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const latency = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP latency",
  labelNames: ["method", "route"] as const,
  registers: [registry],
});

export const events = new Counter({
  name: "wallet_transfers_total",
  help: "Transfer domain events",
  labelNames: ["event"] as const,
  registers: [registry],
});