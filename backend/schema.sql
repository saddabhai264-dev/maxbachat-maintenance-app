-- =====================================================================
-- MAXBACHAT Maintenance Department — Database schema (PostgreSQL)
-- Run this once against your DigitalOcean managed Postgres database:
--   psql "$DATABASE_URL" -f schema.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS branches (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  no_team     BOOLEAN NOT NULL DEFAULT FALSE   -- true for locations with no local captain/auditor/team (e.g. JDC, Mandi)
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,              -- login id, e.g. CAP-BR1
  password_hash TEXT NOT NULL,                 -- bcrypt hash, never plain text
  role          TEXT NOT NULL CHECK (role IN ('captain','auditor','coordinator','reporter','admin','ceo')),
  branch_code   TEXT REFERENCES branches(code),
  name          TEXT NOT NULL,
  phone         TEXT,
  is_head       BOOLEAN NOT NULL DEFAULT FALSE, -- true for the overall Head of Maintenance Department (MT-BR1)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- Which branches/locations a maintenance-team login is responsible for resolving.
-- MT-BR1 (the head) routes BR1 + JDC + MANDI. Other coordinators route only their own branch.
CREATE TABLE IF NOT EXISTS user_routes (
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  branch_code TEXT REFERENCES branches(code),
  PRIMARY KEY (user_id, branch_code)
);

CREATE TABLE IF NOT EXISTS issues (
  id               TEXT PRIMARY KEY,
  branch_code      TEXT NOT NULL REFERENCES branches(code),
  title            TEXT NOT NULL,
  category         TEXT NOT NULL,
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','verified','pending_review','closed')),
  is_old           BOOLEAN NOT NULL DEFAULT FALSE,   -- true for backdated/historical entries
  open_proof       TEXT,
  opened_by        TEXT REFERENCES users(id),
  opened_by_name   TEXT,
  opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      TEXT REFERENCES users(id),
  verified_by_name TEXT,
  verified_at      TIMESTAMPTZ,
  auditor_note     TEXT,
  closed_by        TEXT REFERENCES users(id),
  closed_by_name   TEXT,
  closed_at        TIMESTAMPTZ,
  close_proof      TEXT,
  deadline_at      TIMESTAMPTZ,
  deadline_set_by  TEXT REFERENCES users(id),
  deadline_set_by_name TEXT,
  deadline_note    TEXT,
  resolved_by      TEXT REFERENCES users(id),
  resolved_by_name TEXT,
  resolved_at      TIMESTAMPTZ,
  final_verified_by TEXT REFERENCES users(id),
  final_verified_by_name TEXT,
  final_verified_at TIMESTAMPTZ,
  final_verify_note TEXT,
  final_score     INTEGER,
  estimated_cost   NUMERIC,
  approval_status  TEXT NOT NULL DEFAULT 'not_required' CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  approval_required BOOLEAN NOT NULL DEFAULT FALSE,
  approval_requested_at TIMESTAMPTZ,
  approved_by      TEXT REFERENCES users(id),
  approved_by_name TEXT,
  approved_at      TIMESTAMPTZ,
  approval_note    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE issues ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS approval_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES users(id);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS approved_by_name TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS approval_note TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS deadline_set_by TEXT REFERENCES users(id);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS deadline_set_by_name TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS deadline_note TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolved_by TEXT REFERENCES users(id);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolved_by_name TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS final_verified_by TEXT REFERENCES users(id);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS final_verified_by_name TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS final_verified_at TIMESTAMPTZ;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS final_verify_note TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS final_score INTEGER;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_final_score_check;
ALTER TABLE issues ADD CONSTRAINT issues_final_score_check CHECK (final_score IS NULL OR (final_score >= 1 AND final_score <= 5));
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_check;
ALTER TABLE issues ADD CONSTRAINT issues_status_check CHECK (status IN ('open','verified','pending_review','closed'));

-- Photo / video proof, stored in DigitalOcean Spaces. captured_at / latitude / longitude
-- are already here and ready for the upcoming "live camera with timestamp + location stamp" feature —
-- no schema change will be needed when that's built.
CREATE TABLE IF NOT EXISTS issue_media (
  id            SERIAL PRIMARY KEY,
  issue_id      TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  phase         TEXT NOT NULL CHECK (phase IN ('open','close')),
  media_type    TEXT NOT NULL CHECK (media_type IN ('image','video')),
  spaces_key    TEXT NOT NULL,
  url           TEXT NOT NULL,
  captured_at   TIMESTAMPTZ,      -- reserved: exact camera capture time
  latitude      NUMERIC,          -- reserved: GPS latitude at capture
  longitude     NUMERIC,          -- reserved: GPS longitude at capture
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issues_branch  ON issues(branch_code);
CREATE INDEX IF NOT EXISTS idx_issues_status  ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_approval ON issues(approval_status);
CREATE INDEX IF NOT EXISTS idx_media_issue    ON issue_media(issue_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    TEXT,
  actor_name  TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_target  ON audit_logs(target_type, target_id);

CREATE TABLE IF NOT EXISTS notification_logs (
  id          BIGSERIAL PRIMARY KEY,
  issue_id    TEXT REFERENCES issues(id) ON DELETE SET NULL,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  phone       TEXT,
  event_type  TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_issue ON notification_logs(issue_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user  ON notification_logs(user_id);

CREATE TABLE IF NOT EXISTS visit_logs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_name    TEXT NOT NULL,
  branch_code  TEXT NOT NULL REFERENCES branches(code),
  note         TEXT,
  latitude     NUMERIC,
  longitude    NUMERIC,
  visited_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_visits_branch ON visit_logs(branch_code, visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_user   ON visit_logs(user_id, visited_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
