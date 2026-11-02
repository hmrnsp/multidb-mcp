-- MySQL 8.4 & MariaDB 11.4 seed for developing and testing multidb-mcp.
-- Run automatically by the mysql/mariadb image in database `app` when the volume is still empty.
-- Deliberately uses syntax supported by both MySQL and MariaDB (no recursive CTE).

CREATE TABLE customers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(150) NOT NULL UNIQUE,
  nik           CHAR(16),
  password_hash VARCHAR(100),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE = InnoDB;

CREATE TABLE orders (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  total       DECIMAL(12, 2) NOT NULL,
  status      VARCHAR(20) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_orders_customer (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE = InnoDB;

CREATE VIEW v_order_summary AS
SELECT c.id AS customer_id, c.name, COUNT(o.id) AS order_count, SUM(o.total) AS total_spent
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name;

-- Helper table of numbers 0-9 (a regular table, because a TEMPORARY table cannot be self-joined in MySQL).
CREATE TABLE _digits (d INT NOT NULL);
INSERT INTO _digits (d) VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);

-- 50 customers; the nik & password_hash columns are there on purpose to test masking.
INSERT INTO customers (name, email, nik, password_hash)
SELECT CONCAT('Customer ', n),
       CONCAT('customer', n, '@example.test'),
       LPAD(n, 16, '0'),
       CONCAT('hash-', n)
FROM (SELECT a.d * 10 + b.d + 1 AS n FROM _digits a CROSS JOIN _digits b) AS seq
WHERE n <= 50
ORDER BY n;

-- 1000 orders: more than the default maxRows limit (200), to test result truncation.
INSERT INTO orders (customer_id, total, status)
SELECT MOD(n, 50) + 1,
       n * 1.5,
       ELT(MOD(n, 4) + 1, 'pending', 'paid', 'shipped', 'cancelled')
FROM (
  SELECT a.d * 100 + b.d * 10 + c.d + 1 AS n
  FROM _digits a CROSS JOIN _digits b CROSS JOIN _digits c
) AS seq
ORDER BY n;

DROP TABLE _digits;

-- SELECT-only user: the minimal-privilege model recommended for MCP.
CREATE USER 'mcp_ro'@'%' IDENTIFIED BY 'mcp_ro';
GRANT SELECT ON app.* TO 'mcp_ro'@'%';
