/**
 * Tiny HTML templates for outbound notifications. Kept intentionally light —
 * full responsive templates can be carried from BC original later if needed.
 */

function urgencyColor(urgency: string): string {
  switch ((urgency || '').toLowerCase()) {
    case 'emergency': return '#ef4444';
    case 'high': return '#f59e0b';
    case 'medium': return '#1a73e8';
    default: return '#6b7280';
  }
}

function baseLayout(title: string, accent: string, bodyHtml: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;max-width:600px;margin:0 auto;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
<tr><td style="background:${accent};padding:24px 32px;color:#fff;font-size:18px;font-weight:600;">${title}</td></tr>
<tr><td style="padding:24px 32px;color:#1f2937;font-size:14px;line-height:1.6;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 32px;background:#f9fafb;color:#6b7280;font-size:12px;">— Property Maintenance Agent</td></tr>
</table></body></html>`;
}

export function vendorJobAssignedEmail(args: {
  ticketId: string;
  propertyName: string;
  issueType: string;
  urgency: string;
  description: string;
  location?: string;
  tenantAccessNotes?: string | null;
  images?: string[];
}) {
  const accent = urgencyColor(args.urgency);
  const imgsHtml = (args.images || []).slice(0, 3).map(u =>
    `<img src="${u}" alt="issue photo" style="max-width:170px;margin:4px;border-radius:6px;">`
  ).join('');

  const body = `
<p><strong>New job assigned:</strong> ${args.ticketId}</p>
<p><strong>Property:</strong> ${args.propertyName}</p>
<p><strong>Issue:</strong> ${args.issueType} • <span style="color:${accent};font-weight:600;">${args.urgency.toUpperCase()}</span></p>
<p><strong>Description:</strong> ${escapeHtml(args.description)}</p>
${args.location ? `<p><strong>Location:</strong> ${escapeHtml(args.location)}</p>` : ''}
${args.tenantAccessNotes ? `<p><strong>Access:</strong> ${escapeHtml(args.tenantAccessNotes)}</p>` : ''}
${imgsHtml ? `<div style="margin-top:12px;">${imgsHtml}</div>` : ''}
<p style="margin-top:16px;">Please respond with a quote and scheduled visit time.</p>`;

  return {
    subject: `New maintenance job: ${args.ticketId} (${args.urgency})`,
    html: baseLayout(`Job ${args.ticketId}`, accent, body)
  };
}

export function tenantTicketCreatedEmail(args: {
  ticketId: string;
  propertyName: string;
  issueType: string;
  urgency: string;
  description: string;
  vendorName?: string;
}) {
  const accent = urgencyColor(args.urgency);
  const body = `
<p>Hi! Your maintenance request has been logged:</p>
<p><strong>Ticket:</strong> ${args.ticketId}<br/>
<strong>Property:</strong> ${args.propertyName}<br/>
<strong>Issue:</strong> ${args.issueType} (${args.urgency})</p>
<p>${escapeHtml(args.description)}</p>
${args.vendorName ? `<p><strong>${args.vendorName}</strong> has been notified and will be in touch shortly.</p>` : '<p>We are matching a vendor to your issue and will update you shortly.</p>'}
<p>You can check the status anytime by replying to this thread or messaging us on WhatsApp.</p>`;
  return {
    subject: `Maintenance ticket ${args.ticketId} created`,
    html: baseLayout(`Ticket ${args.ticketId} created`, accent, body)
  };
}

export function approvalRequestEmail(args: {
  ticketId: string;
  vendorName: string;
  amount: number;
  currency: string;
  scopeNotes: string;
  propertyName: string;
  approveUrl?: string;
  rejectUrl?: string;
}) {
  const body = `
<p>An approval is required for ticket <strong>${args.ticketId}</strong>:</p>
<ul>
  <li><strong>Property:</strong> ${args.propertyName}</li>
  <li><strong>Vendor:</strong> ${args.vendorName}</li>
  <li><strong>Quote:</strong> ${args.currency}${args.amount.toFixed(2)}</li>
  <li><strong>Scope:</strong> ${escapeHtml(args.scopeNotes)}</li>
</ul>
${args.approveUrl ? `<p><a href="${args.approveUrl}" style="background:#0d9488;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Approve</a>${args.rejectUrl ? `&nbsp;<a href="${args.rejectUrl}" style="background:#ef4444;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Reject</a>` : ''}</p>` : ''}`;
  return {
    subject: `Approval requested: ${args.ticketId} (${args.currency}${args.amount.toFixed(2)})`,
    html: baseLayout('Approval requested', '#1a73e8', body)
  };
}

export function escalationNotificationEmail(args: {
  ticketId: string;
  escalationType: string;
  reason: string;
  urgency: string;
  propertyName?: string;
  vendorName?: string;
  currentStatus?: string;
  tenantName?: string;
}) {
  const accent = urgencyColor(args.urgency);
  const body = `
<p><strong>Escalation:</strong> ${args.escalationType.replace(/_/g, ' ')}</p>
<p><strong>Ticket:</strong> ${args.ticketId}</p>
${args.propertyName ? `<p><strong>Property:</strong> ${args.propertyName}</p>` : ''}
${args.tenantName ? `<p><strong>Tenant:</strong> ${args.tenantName}</p>` : ''}
${args.vendorName ? `<p><strong>Vendor:</strong> ${args.vendorName}</p>` : ''}
${args.currentStatus ? `<p><strong>Status:</strong> ${args.currentStatus}</p>` : ''}
<p><strong>Reason:</strong> ${escapeHtml(args.reason)}</p>`;
  return {
    subject: `Escalation: ${args.ticketId} — ${args.escalationType.replace(/_/g, ' ')}`,
    html: baseLayout('Escalation raised', accent, body),
    body: `Escalation: ${args.escalationType}\nTicket: ${args.ticketId}\nReason: ${args.reason}`
  };
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
