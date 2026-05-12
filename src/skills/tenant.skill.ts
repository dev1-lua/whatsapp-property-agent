import { LuaSkill } from 'lua-cli';

// Identity (CALL FIRST, ALWAYS)
import { GetUserContextTool } from '../tools/intake/GetUserContextTool.js';
import { RegisterSelfAsTenantTool } from '../tools/intake/RegisterSelfAsTenantTool.js';
import { RegisterSelfAsVendorTool } from '../tools/intake/RegisterSelfAsVendorTool.js';

// Intake
import { CreateMaintenanceTicketTool } from '../tools/intake/CreateMaintenanceTicketTool.js';
import { UploadIssueImagesTool } from '../tools/intake/UploadIssueImagesTool.js';
import { UpdateTicketDetailsTool } from '../tools/intake/UpdateTicketDetailsTool.js';
import { SearchMaintenanceHistoryTool } from '../tools/intake/SearchMaintenanceHistoryTool.js';
import { MyTicketsTool } from '../tools/intake/MyTicketsTool.js';

// Tenant-side vendor management
import { LookupVendorsTool } from '../tools/vendor/LookupVendorsTool.js';
import { SendVendorRequestTool } from '../tools/vendor/SendVendorRequestTool.js';
import { RecordVendorQuoteTool } from '../tools/vendor/RecordVendorQuoteTool.js';
import { UpdateVendorMetricsTool } from '../tools/vendor/UpdateVendorMetricsTool.js';

// Approval
import { CheckApprovalThresholdTool } from '../tools/approval/CheckApprovalThresholdTool.js';
import { SendForApprovalTool } from '../tools/approval/SendForApprovalTool.js';
import { RecordFinanceDecisionTool } from '../tools/approval/RecordFinanceDecisionTool.js';
import { InitiatePaymentTool } from '../tools/approval/InitiatePaymentTool.js';

// Completion
import { RecordCompletionDocsTool } from '../tools/completion/RecordCompletionDocsTool.js';
import { RequestTenantConfirmationTool } from '../tools/completion/RequestTenantConfirmationTool.js';
import { RecordTenantDisputeTool } from '../tools/completion/RecordTenantDisputeTool.js';
import { CloseTicketTool } from '../tools/completion/CloseTicketTool.js';

// Escalation
import { EscalateTicketTool } from '../tools/escalation/EscalateTicketTool.js';

// Admin stats (manager-on-WhatsApp / dropdown-admin views)
import { GetOpenTicketCountTool } from '../tools/admin/GetOpenTicketCountTool.js';
import { ListTicketsInProgressTool } from '../tools/admin/ListTicketsInProgressTool.js';
import { ListPendingApprovalsTool } from '../tools/admin/ListPendingApprovalsTool.js';
import { ListRecentActivityTool } from '../tools/admin/ListRecentActivityTool.js';
import { VendorsBySpecialtyTool } from '../tools/admin/VendorsBySpecialtyTool.js';

export const tenantSkill = new LuaSkill({
  name: 'tenant',
  description:
    'Tenant-facing maintenance flow plus ops-side vendor coordination, approvals, completion tracking, escalations, and admin/manager read-only stats.',
  context: `
    Tools for tenants reporting maintenance issues, plus operator-side coordination of vendors and finance.

    **User Identification (ALWAYS call first)**
    - get_user_context: identifies tenant vs vendor vs admin from phone/email. NO input needed.
    - register_self_as_tenant: onboard an unregistered tenant inline (name + property/unit)
    - register_self_as_vendor: onboard an unregistered vendor inline (companyName + specialties[])

    **Tenant intake**
    - create_maintenance_ticket — create ticket; auto-classifies + auto-assigns vendor
    - upload_issue_images — append CDN-hosted image URLs (call CDN.upload separately)
    - update_ticket_details — description / location / urgency / access notes (open tickets only)
    - search_maintenance_history — semantic search over past tickets
    - my_tickets — list/cancel tickets for the current tenant

    **Vendor coordination**
    - lookup_vendors — find vendors by issue type, sorted by rating
    - send_vendor_request — assign a specific vendor to a ticket
    - record_vendor_quote — record a quote that arrived out-of-band
    - update_vendor_metrics — bump rating/jobs/revenue after completion

    **Approval workflow**
    - check_approval_threshold — pure compare against APPROVAL_THRESHOLD env var
    - send_for_approval — routes over-threshold quotes to APPROVER_EMAIL
    - record_finance_decision — record approve/reject decision
    - initiate_payment — Stripe stub; marks payment processing

    **Completion**
    - record_completion_docs — vendor completion artifacts (photos, invoice, notes)
    - request_tenant_confirmation — ask tenant to confirm satisfaction
    - record_tenant_dispute — moves status to disputed + creates escalation
    - close_ticket — final close after confirmation (or manager override)

    **Escalation**
    - escalate_ticket — create an escalation entry + notify manager

    **Admin stats (admin/manager only — read-only)**
    - get_open_ticket_count — total of non-closed tickets, optionally grouped by status/urgency/issueType/propertyCode
    - list_tickets_in_progress — tickets currently being worked (vendor_contacted → in_progress, plus on_hold)
    - list_pending_approvals — tickets stuck at status=pending_approval with quote/waiting-time context
    - list_recent_activity — most recent audit events newest-first, scope-aware
    - vendors_by_specialty — vendor roster filtered by specialty + active flag

    **Workflow rules**
    - tickets progress reported → vendor_contacted → quoted → [pending_approval] → approved → in_progress → completed → closed
    - quotes > APPROVAL_THRESHOLD route to finance; ≤ auto-approve
    - closure requires completion docs + tenant confirmation (or manager override)
    - log every status change through the tool's logStatusChange path
  `,
  tools: [
    new GetUserContextTool(),
    new RegisterSelfAsTenantTool(),
    new RegisterSelfAsVendorTool(),
    new CreateMaintenanceTicketTool(),
    new UploadIssueImagesTool(),
    new UpdateTicketDetailsTool(),
    new SearchMaintenanceHistoryTool(),
    new MyTicketsTool(),
    new LookupVendorsTool(),
    new SendVendorRequestTool(),
    new RecordVendorQuoteTool(),
    new UpdateVendorMetricsTool(),
    new CheckApprovalThresholdTool(),
    new SendForApprovalTool(),
    new RecordFinanceDecisionTool(),
    new InitiatePaymentTool(),
    new RecordCompletionDocsTool(),
    new RequestTenantConfirmationTool(),
    new RecordTenantDisputeTool(),
    new CloseTicketTool(),
    new EscalateTicketTool(),
    new GetOpenTicketCountTool(),
    new ListTicketsInProgressTool(),
    new ListPendingApprovalsTool(),
    new ListRecentActivityTool(),
    new VendorsBySpecialtyTool()
  ]
});

export default tenantSkill;
