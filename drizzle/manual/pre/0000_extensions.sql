-- Idempotent. Runs BEFORE the generated migrations (trigram indexes need pg_trgm).
create extension if not exists pg_trgm;
