# SQL & Database Conventions

## Parameterized Queries — Mandatory

Never concatenate user input into SQL strings. This is the #1 security vulnerability.

```sql
-- Bad — SQL injection
SELECT * FROM users WHERE email = '${email}';

-- Good — parameterized (placeholder syntax varies by driver)
SELECT * FROM users WHERE email = ?;
```

- Use parameterized queries everywhere: `?` (MySQL/SQLite), `$1` (Postgres), `:name` (named params)
- ORMs: ensure the ORM parameterizes. Raw queries still need placeholders.
- **No dynamic table/column/group BY names from user input** — use allowlists for these
- Stored procedures: use parameterized calls, never `EXEC` with string concatenation

## Migration Safety — Mandatory

Every migration must be reversible and non-destructive.

```sql
-- Migration: add column (safe, non-blocking)
ALTER TABLE users ADD COLUMN preferences JSONB DEFAULT '{}' NOT NULL;

-- Migration: drop column (DANGEROUS — requires multi-step)
-- Step 1: Stop writing to column in application code. Deploy.
-- Step 2: Migration to drop column (only after confirming no reads/writes).
```

- **Never drop a column or table in the same migration that adds it** — split into separate deploys
- **Never rename a column**: the old name still exists in running application code. Add new column, dual-write, migrate data, remove old column.
- **Backfill large tables in batches**, not in a single transaction:

```sql
-- Bad — locks the table for minutes
UPDATE users SET status = 'active' WHERE status IS NULL;

-- Good — batch processing
UPDATE users SET status = 'active'
WHERE id IN (SELECT id FROM users WHERE status IS NULL LIMIT 1000);
-- Repeat until no rows affected
```

- **Always add a default value** for new NOT NULL columns
- **Test rollback**: every `up` migration must have a tested `down` migration
- **Use advisory locks** for migrations that shouldn't run concurrently across multiple replicas

## Indexing

Indexes are free to read but expensive to write. Be intentional.

```sql
-- Covering index for common query pattern
CREATE INDEX idx_users_email_status ON users (email, status);

-- Partial index — only indexes rows matching condition (smaller, faster)
CREATE INDEX idx_orders_pending ON orders (created_at)
    WHERE status = 'pending';

-- Index on expression (Postgres)
CREATE INDEX idx_users_lower_email ON users (LOWER(email));
```

- **Index columns used in WHERE, JOIN, ORDER BY** — every such column should be indexed or justified
- **Multi-column index column order matters**: most selective columns first. Index on `(a, b)` covers queries on `(a)` and `(a, b)` but NOT `(b)` alone
- **Check the query plan**: `EXPLAIN ANALYZE` before and after adding indexes
- **Don't over-index**: every index slows down INSERT/UPDATE/DELETE. Index what you query, not everything.
- **Remove unused indexes**: they waste disk space and write performance

## Connection Pooling

Never create a new connection per request.

- **Use the framework's connection pool**: `pgbouncer`, `HikariCP`, `sqlx::PgPool`, SQLAlchemy `QueuePool`
- **Pool size**: start with `(2 * CPU cores) + 1` for active connections. Tune from there, never default to 100.
- **Connection timeout**: 30 seconds max. A stuck connection holds a pool slot and degrades everything.
- **Statement timeout**: set at the pool level to prevent runaway queries:

```sql
-- Postgres: abort any query that runs longer than 30s
SET statement_timeout = '30s';
```

- **Never leak connections**: use `try-with-resources`, `defer`, context managers, or async pools that auto-return

## Transaction Boundaries

Every write that touches multiple rows or tables needs a transaction.
