/** True for a real IANA zone name (e.g. Africa/Lagos, Africa/Accra, UTC). */
export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
