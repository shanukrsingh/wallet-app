CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_token TEXT NOT NULL UNIQUE,
  balance_paise BIGINT NOT NULL DEFAULT 100000 CHECK (balance_paise >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  from_wallet_id UUID NOT NULL REFERENCES wallets(id),
  to_wallet_id UUID NOT NULL REFERENCES wallets(id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'declined')),
  reversal_of_id UUID REFERENCES transfers(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_wallet_id <> to_wallet_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_reversal
  ON transfers(reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;
