-- Run this in your Neon SQL Editor if you want to set up tables manually
-- (server.js also creates them automatically on first start)

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS log_types (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id SERIAL PRIMARY KEY,
  log_type_id INTEGER REFERENCES log_types(id),
  upload_date DATE NOT NULL,
  user_id INTEGER REFERENCES users(id),
  image_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(log_type_id, upload_date, user_id)
);

-- Seed log types
INSERT INTO log_types (name) VALUES
  ('Canister Log Book'),
  ('Temperature Log Book'),
  ('Petty Cash Expense Book'),
  ('Inventory Book'),
  ('Generator Log Book')
ON CONFLICT (name) DO NOTHING;
