-- PostgreSQL seed for developing and testing multidb-mcp.
-- Run automatically by the postgres image when the volume is still empty.
-- The structure matches the MySQL/MariaDB and Db2 seeds so test results can be compared.

CREATE SCHEMA app;

CREATE TABLE app.customers (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  nik           CHAR(16),
  password_hash VARCHAR(100),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE app.orders (
  id          SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES app.customers (id),
  total       NUMERIC(12, 2) NOT NULL,
  status      VARCHAR(20) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orders_customer ON app.orders (customer_id);

CREATE VIEW app.v_order_summary AS
SELECT c.id AS customer_id, c.name, COUNT(o.id) AS order_count, SUM(o.total) AS total_spent
FROM app.customers c
LEFT JOIN app.orders o ON o.customer_id = c.id
GROUP BY c.id, c.name;

-- 50 customers; the nik & password_hash columns are there on purpose to test masking.
INSERT INTO app.customers (name, email, nik, password_hash)
SELECT 'Customer ' || i,
       'customer' || i || '@example.test',
       LPAD(i::text, 16, '0'),
       'hash-' || i
FROM generate_series(1, 50) AS s(i);

-- 1000 orders: more than the default maxRows limit (200), to test result truncation.
INSERT INTO app.orders (customer_id, total, status)
SELECT (i % 50) + 1,
       (i * 1.5)::NUMERIC(12, 2),
       (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[(i % 4) + 1]
FROM generate_series(1, 1000) AS s(i);

-- SELECT-only user: the minimal-privilege model recommended for MCP.
CREATE ROLE mcp_ro LOGIN PASSWORD 'mcp_ro';
GRANT CONNECT ON DATABASE app TO mcp_ro;
GRANT USAGE ON SCHEMA app TO mcp_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO mcp_ro;
