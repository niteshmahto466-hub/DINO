-- Run once in the Neon SQL editor.
CREATE TABLE IF NOT EXISTS users (
  id           BIGINT PRIMARY KEY,                 -- Telegram user id
  username     TEXT,
  balance      NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  referrer_id  BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_referrer_idx ON users(referrer_id);

CREATE TABLE IF NOT EXISTS deposits (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  coin            TEXT NOT NULL,
  address         TEXT,
  amount_usd      NUMERIC(20,8) NOT NULL CHECK (amount_usd > 0),
  coins_credited  NUMERIC(20,8),
  track_id        TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS deposits_user_idx ON deposits(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  coin          TEXT NOT NULL,
  address       TEXT NOT NULL,
  amount_coins  NUMERIC(20,8) NOT NULL CHECK (amount_coins > 0),
  amount_usd    NUMERIC(20,8) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS withdrawals_user_idx ON withdrawals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals(status, created_at DESC);

-- Referral earnings: 'signup' = fixed bonus per invited partner, 'deposit' = percent of the referral's deposit.
CREATE TABLE IF NOT EXISTS referral_commissions (
  id           BIGSERIAL PRIMARY KEY,
  referrer_id  BIGINT NOT NULL REFERENCES users(id),
  referred_id  BIGINT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('signup','deposit')),
  deposit_id   BIGINT UNIQUE REFERENCES deposits(id),   -- one commission per deposit
  amount       NUMERIC(20,8) NOT NULL,
  collected    BOOLEAN NOT NULL DEFAULT false,           -- the "Collect" button on the referral page
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (referrer_id, referred_id, kind, deposit_id)
);
CREATE INDEX IF NOT EXISTS commissions_referrer_idx ON referral_commissions(referrer_id, created_at DESC);

-- Audit trail: every balance change is recorded.
CREATE TABLE IF NOT EXISTS balance_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  delta       NUMERIC(20,8) NOT NULL,
  reason      TEXT NOT NULL,       -- deposit | withdraw | withdraw_refund | commission_collect
  ref_id      BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
