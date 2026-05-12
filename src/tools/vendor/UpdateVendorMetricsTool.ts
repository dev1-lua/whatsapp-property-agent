/**
 * Update a vendor's running performance metrics after job completion.
 * Bumps jobsCompleted, adds to totalRevenue, and computes a new rating as a
 * weighted average over previously rated jobs.
 */

import { LuaTool } from 'lua-cli';
import { z } from 'zod';
import { Vendors } from '../../services/data.js';

export class UpdateVendorMetricsTool implements LuaTool {
  name = 'update_vendor_metrics';
  description = 'After a job completes, update a vendor\'s jobsCompleted, totalRevenue, and rating (weighted-average if a rating is given).';

  inputSchema = z.object({
    vendorId: z.string().describe('Data entry id of the vendor whose metrics to update'),
    ticketId: z.string().describe('Display ticket ID, e.g. MT-2605-A8F2K9 — for audit context'),
    rating: z.number().min(1).max(5).optional().describe('Optional new rating for this job (1-5)'),
    costActual: z.number().min(0).optional().describe('Optional actual cost paid for this job, added to totalRevenue')
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    try {
      const { vendorId, rating, costActual } = input;

      const vendorEntry = await Vendors.getEntry(vendorId);
      const vendor: any = vendorEntry?.data;
      if (!vendorEntry || !vendor) {
        return {
          success: false,
          error: 'vendor_not_found',
          message: `Vendor ${vendorId} not found.`
        };
      }

      const prevJobs = Number(vendor.jobsCompleted ?? 0);
      const prevRating = Number(vendor.rating ?? 0);
      const prevRevenue = Number(vendor.totalRevenue ?? 0);

      const newJobsCompleted = prevJobs + 1;
      const newTotalRevenue = costActual !== undefined ? prevRevenue + costActual : prevRevenue;

      // Weighted average rating: only count this rating if provided. We weight
      // the previous rating by prevJobs (jobs we have rated history for) and
      // the new rating by 1.
      let newRating = prevRating;
      if (rating !== undefined) {
        if (prevJobs <= 0 || prevRating <= 0) {
          newRating = rating;
        } else {
          const weighted = (prevRating * prevJobs + rating) / (prevJobs + 1);
          newRating = Math.round(weighted * 100) / 100;
        }
      }

      const now = new Date().toISOString();
      await Vendors.update(vendorEntry.id, {
        ...vendor,
        jobsCompleted: newJobsCompleted,
        totalRevenue: newTotalRevenue,
        rating: newRating,
        updatedAt: now
      });

      return {
        success: true,
        vendorId,
        newRating,
        jobsCompleted: newJobsCompleted,
        totalRevenue: newTotalRevenue,
        message: `Vendor metrics updated. Jobs: ${newJobsCompleted}, rating: ${newRating}, total revenue: ${newTotalRevenue}.`
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        message: 'Failed to update vendor metrics.'
      };
    }
  }
}

export default UpdateVendorMetricsTool;
