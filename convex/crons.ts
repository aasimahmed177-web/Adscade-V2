import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Calendly Free plan has no webhooks. Polling is the substitute — see
// docs/CALENDLY_FREE_SYNC.md for what each run does and the expected detection delay.
crons.interval("calendly booking sync", { minutes: 5 }, internal.calendly.sync, {});

// Convex is authoritative. Retry any lead whose Google Sheets reporting mirror has
// not reached the synced state, without involving the visitor's browser.
crons.interval("google sheets mirror reconciliation", { hours: 1 }, internal.sheets.reconcileUnsynced, {});

export default crons;
