import { LuaSkill } from 'lua-cli';

import { GetUserContextTool } from '../tools/intake/GetUserContextTool.js';
import { ListAvailableJobsTool } from '../tools/vendor/ListAvailableJobsTool.js';
import { ClaimJobTool } from '../tools/vendor/ClaimJobTool.js';
import { DeclineJobTool } from '../tools/vendor/DeclineJobTool.js';
import { MyAssignedJobsTool } from '../tools/vendor/MyAssignedJobsTool.js';
import { SubmitQuoteTool } from '../tools/vendor/SubmitQuoteTool.js';
import { SubmitRevisedQuoteTool } from '../tools/vendor/SubmitRevisedQuoteTool.js';
import { StartWorkTool } from '../tools/vendor/StartWorkTool.js';
import { PauseWorkTool } from '../tools/vendor/PauseWorkTool.js';
import { CompleteJobTool } from '../tools/vendor/CompleteJobTool.js';
import { UploadVendorPhotosTool } from '../tools/vendor/UploadVendorPhotosTool.js';
import { ValidateInvoiceTool } from '../tools/vendor/ValidateInvoiceTool.js';

export const vendorSkill = new LuaSkill({
  name: 'vendor',
  description: 'Vendor-facing tools: browse jobs, claim, quote, schedule, complete.',
  context: `
    Tools for VENDORS responding to maintenance jobs.

    **Identity**
    - get_user_context: ALWAYS call first; expect userType='vendor'

    **Browse + claim**
    - list_available_jobs: jobs matching vendor's specialty (open/assigned-but-unclaimed)
    - claim_job: vendor self-assigns to a ticket
    - decline_job: vendor declines a claimed/auto-assigned job — ticket resets to reported
    - my_assigned_jobs: list all of this vendor's jobs (any status filter)

    **Quote**
    - submit_quote: initial quote; auto-approves if ≤ APPROVAL_THRESHOLD, else pending_approval + email finance
    - submit_revised_quote: for scope changes / rejected-and-resubmitted quotes

    **Work**
    - start_work: transitions approved → in_progress
    - pause_work: in_progress → on_hold (requires reason)
    - complete_job: REQUIRES photos + invoice. Transitions to completed.
    - upload_vendor_photos: progress or completion photos
    - validate_invoice: checks extracted invoice data against ticket quote

    **Rules**
    - Always validate the vendor is the one assigned before mutating a ticket (handled inside each tool)
    - Status transitions enforced via VALID_TRANSITIONS (handled inside each tool)
    - Completion requires both completion photos and invoice details — never skip
  `,
  tools: [
    new GetUserContextTool(),
    new ListAvailableJobsTool(),
    new ClaimJobTool(),
    new DeclineJobTool(),
    new MyAssignedJobsTool(),
    new SubmitQuoteTool(),
    new SubmitRevisedQuoteTool(),
    new StartWorkTool(),
    new PauseWorkTool(),
    new CompleteJobTool(),
    new UploadVendorPhotosTool(),
    new ValidateInvoiceTool()
  ]
});

export default vendorSkill;
