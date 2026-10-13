import { env } from '../../env.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const wrap = (title: string, bodyHtml: string) =>
  `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto"><h2>${esc(title)}</h2>${bodyHtml}<p style="color:#888;font-size:12px">StoreKeeper</p></div>`;

export function inviteEmail(orgName: string, role: string, token: string, inviter?: string | null) {
  const link = `${env.APP_BASE_URL}/accept-invite?token=${encodeURIComponent(token)}`;
  return {
    subject: `You've been invited to ${orgName} on StoreKeeper`,
    text: `${inviter ? `${inviter} has invited` : 'You have been invited'} you to join ${orgName} as ${role}.\n\nSet your password to get started (link valid for ${Math.round(env.INVITE_TTL_SECONDS / 86400)} days):\n${link}\n`,
    html: wrap(`Join ${orgName}`, `<p>You've been invited as <b>${esc(role)}</b>.</p><p><a href="${esc(link)}">Set your password</a></p>`),
  };
}

export function passwordResetEmail(token: string) {
  const link = `${env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: 'Reset your StoreKeeper password',
    text: `Use this link to choose a new password (valid for ${Math.round(env.PASSWORD_RESET_TTL_SECONDS / 60)} minutes):\n${link}\n\nIf you didn't ask for this, ignore this email — your password is unchanged.\n`,
    html: wrap('Reset your password', `<p><a href="${esc(link)}">Choose a new password</a></p><p>If you didn't ask for this, ignore this email.</p>`),
  };
}

export function notificationEmail(title: string, body: string) {
  return { subject: title, text: `${body}\n\nOpen StoreKeeper: ${env.APP_BASE_URL}\n`, html: wrap(title, `<p>${esc(body)}</p>`) };
}
