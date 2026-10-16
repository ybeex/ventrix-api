-- Addresses we must not mail again: hard bounces, spam complaints and unsubscribes reported by the Mailgun webhook
-- (POST /v1/webhooks/mailgun). Global (an address that bounces for one organization bounces for all). Idempotent.
create table if not exists email_suppressions (
  email      text primary key,                 -- lower-cased
  reason     text not null check (reason in ('bounce', 'complaint', 'unsubscribe')),
  event_id   text,                             -- Mailgun event id (for support)
  detail     text,                             -- provider message, truncated
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
