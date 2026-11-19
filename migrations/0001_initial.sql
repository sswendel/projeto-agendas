CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  whatsapp_phone TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (id)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (business_id, id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  phone_normalized TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, id),
  UNIQUE (business_id, phone_normalized)
);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 720),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, id)
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, id)
);

CREATE TABLE availability_rules (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  CHECK (start_time < end_time),
  UNIQUE (business_id, id)
);

CREATE TABLE availability_exceptions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  exception_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('closed', 'extra_hours', 'blocked')),
  start_time TEXT,
  end_time TEXT,
  note TEXT NOT NULL DEFAULT '',
  CHECK ((start_time IS NULL AND end_time IS NULL) OR start_time < end_time),
  UNIQUE (business_id, id)
);

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  service_name_snapshot TEXT NOT NULL,
  duration_minutes_snapshot INTEGER NOT NULL,
  price_cents_snapshot INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled', 'completed', 'expired')),
  source TEXT NOT NULL CHECK (source IN ('public', 'manual')),
  notes TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  tracking_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (starts_at < ends_at),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, service_id) REFERENCES services(business_id, id)
);

CREATE TABLE appointment_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('requested', 'approved', 'declined', 'cancelled', 'completed', 'rescheduled')),
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (business_id, appointment_id) REFERENCES appointments(business_id, id) ON DELETE CASCADE
);

CREATE TABLE financial_categories (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('receivable', 'payable')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (business_id, id),
  UNIQUE (business_id, name, direction)
);

CREATE TABLE financial_entries (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('receivable', 'payable')),
  customer_id TEXT,
  appointment_id TEXT,
  product_id TEXT,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  due_date TEXT NOT NULL,
  settled_at TEXT,
  payment_method TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, category_id) REFERENCES financial_categories(business_id, id),
  FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  FOREIGN KEY (business_id, appointment_id) REFERENCES appointments(business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES products(business_id, id)
);

CREATE INDEX idx_appointments_business_start ON appointments(business_id, starts_at);
CREATE INDEX idx_appointments_business_status ON appointments(business_id, status, expires_at);
CREATE INDEX idx_customers_business_name ON customers(business_id, name);
CREATE INDEX idx_financial_entries_business_due ON financial_entries(business_id, due_date, direction);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
