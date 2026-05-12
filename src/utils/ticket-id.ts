/**
 * Ticket ID generator — timestamp + random suffix.
 *
 * Format: MT-{yy}{mm}-{6-char base36 upper}
 * Example: MT-2605-A8F2K9
 *
 * No global counter, no race condition. Unique enough for demo + production scale.
 */

export function generateTicketId(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `MT-${yy}${mm}-${rand}`;
}

export function isValidTicketId(ticketId: string): boolean {
  return /^MT-\d{4}-[A-Z0-9]{6}$/.test(ticketId);
}

export function getTicketYearMonth(ticketId: string): { year: number; month: number } | null {
  const match = ticketId.match(/^MT-(\d{2})(\d{2})-[A-Z0-9]{6}$/);
  if (!match) return null;
  const yy = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  return { year: 2000 + yy, month: mm };
}
