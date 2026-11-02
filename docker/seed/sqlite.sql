-- SQLite seed for developing and testing multidb-mcp: npm run seed:sqlite -> .data/app.sqlite
-- Same structure and content as the PostgreSQL/MySQL seed so query results can be compared.

CREATE TABLE customers (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  nik           TEXT,
  password_hash TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id          INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  total       NUMERIC NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orders_customer ON orders (customer_id);

CREATE VIEW v_order_summary AS
SELECT c.id AS customer_id, c.name, COUNT(o.id) AS order_count, SUM(o.total) AS total_spent
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name;

-- 50 customers; the nik & password_hash columns are there on purpose to test masking.
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50)
INSERT INTO customers (id, name, email, nik, password_hash)
SELECT n, 'Customer ' || n, 'customer' || n || '@example.test', printf('%016d', n), 'hash-' || n
FROM seq;

-- 1000 orders: more than the default maxRows limit (200), to test result truncation.
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000)
INSERT INTO orders (id, customer_id, total, status)
SELECT n, (n % 50) + 1, n * 1.5,
       CASE n % 4 WHEN 0 THEN 'pending' WHEN 1 THEN 'paid' WHEN 2 THEN 'shipped' ELSE 'cancelled' END
FROM seq;
