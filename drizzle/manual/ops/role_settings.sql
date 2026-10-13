-- NOT run automatically (role names differ per environment). Apply once per environment, as a superuser:
--   psql "$ADMIN_DATABASE_URL" -v app_role=storekeeper -f drizzle/manual/ops/role_settings.sql
-- Role-level (not connection-level) because PgBouncer transaction pooling rejects startup parameters.
alter role :"app_role" set statement_timeout = '15s';                    -- a runaway query is cut off, not left to hold a pooled connection
alter role :"app_role" set lock_timeout = '5s';                          -- never wait forever behind a lock (surfaces as a retryable 503)
alter role :"app_role" set idle_in_transaction_session_timeout = '30s';  -- a crashed client can't pin locks open
