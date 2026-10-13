/**
 * nodemailer over Mailgun SMTP, behind a circuit breaker.
 *
 * Drivers (MAIL_DRIVER): `mailgun` (production; smtp.mailgun.org or smtp.eu.mailgun.org, STARTTLS required),
 * `json` (tests — messages captured in memory), `log` (development — printed, not sent).
 *
 * Breaker semantics: while Mailgun is failing/slow the circuit opens and `sendMail` rejects instantly with
 * DEPENDENCY_UNAVAILABLE. Callers never send mail inline from a request — they write to the outbox
 * (outbox.ts) and the worker retries with backoff — so an open circuit means "mail is delayed", never
 * "request failed" or "mail lost". A *recipient* rejection (SMTP 5xx for a bad address) is the caller's
 * problem, not Mailgun's health, so it is excluded from the breaker's failure statistics.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../env.js';
import { createBreaker } from '../../lib/resilience/circuit.js';

export interface OutboundMail { to: string; subject: string; text: string; html?: string }

/** Captured messages when MAIL_DRIVER=json (tests). */
export const sentMessages: Array<OutboundMail & { sentAt: Date }> = [];

let transport: Transporter | null = null;
function getTransport(): Transporter {
  if (transport) return transport;
  transport = env.MAIL_DRIVER === 'mailgun'
    ? nodemailer.createTransport({
        host: env.MAILGUN_SMTP_HOST,
        port: env.MAILGUN_SMTP_PORT,
        secure: env.MAILGUN_SMTP_PORT === 465,
        requireTLS: env.MAILGUN_SMTP_PORT !== 465, // never downgrade to plaintext SMTP
        auth: { user: env.MAILGUN_SMTP_USER, pass: env.MAILGUN_SMTP_PASS },
        pool: true, maxConnections: 3, maxMessages: 100,
        connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000,
        tls: { minVersion: 'TLSv1.2' },
      })
    : nodemailer.createTransport({ jsonTransport: true });
  return transport;
}

/** SMTP 5xx replies about a specific recipient/message are not evidence that Mailgun is unhealthy. */
const isRecipientProblem = (err: unknown): boolean => {
  const code = (err as { responseCode?: number }).responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
};

const rawSend = async (mail: OutboundMail): Promise<void> => {
  if (env.MAIL_DRIVER === 'log') {
    // eslint-disable-next-line no-console
    console.log(`[mail:log] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
    return;
  }
  await getTransport().sendMail({ from: env.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  if (env.MAIL_DRIVER === 'json') {
    sentMessages.push({ ...mail, sentAt: new Date() });
    if (sentMessages.length > 500) sentMessages.shift();
  }
};

let guarded: ((mail: OutboundMail) => Promise<void>) | null = null;
export function sendMail(mail: OutboundMail): Promise<void> {
  guarded ??= createBreaker('mailgun', rawSend, { timeoutMs: 12_000, ignoreError: isRecipientProblem });
  return guarded(mail);
}
