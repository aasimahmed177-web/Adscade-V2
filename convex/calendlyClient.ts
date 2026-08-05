/**
 * Thin Calendly API v2 client. No Convex imports here on purpose — it only knows how to
 * talk to Calendly, so it can be pointed at a mock server for testing without touching
 * anything database-related.
 *
 * CALENDLY_API_BASE is a Convex environment variable, unset in production. It exists
 * solely so tests can point this client at a local mock instead of api.calendly.com —
 * see docs/CALENDLY_FREE_SYNC.md "Testing without a real booking".
 */

const DEFAULT_BASE = "https://api.calendly.com";

export class CalendlyAuthError extends Error {}
export class CalendlyRateLimitError extends Error {}

function base(): string {
  return (process.env.CALENDLY_API_BASE || DEFAULT_BASE).replace(/\/$/, "");
}

function token(): string {
  const t = process.env.CALENDLY_PAT;
  if (!t) throw new Error("CALENDLY_PAT is not set");
  return t;
}

/**
 * Every Calendly resource's own `uri` field is itself a fetchable URL. This one function
 * handles both "a path under the API base" and "a full resource URI" — callers never
 * need to know which they have.
 */
async function calendlyFetch<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base()}${pathOrUrl}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new CalendlyAuthError(`Calendly rejected the token (${res.status}) for ${url}`);
  }
  if (res.status === 429) {
    throw new CalendlyRateLimitError(`Calendly rate-limited this run (429) at ${url}`);
  }
  if (!res.ok) {
    throw new Error(`Calendly ${res.status} for ${url}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  organization: string;
}

export async function getCurrentUser(): Promise<CalendlyUser> {
  const { resource } = await calendlyFetch<{ resource: CalendlyUser }>("/users/me");
  return resource;
}

export interface CalendlyEventType {
  uri: string;
  name: string;
  active: boolean;
}

/** One page cap is enough for a Free-plan account's event type list. */
export async function listEventTypes(userUri: string): Promise<CalendlyEventType[]> {
  const { collection } = await calendlyFetch<{ collection: CalendlyEventType[] }>(
    `/event_types?user=${encodeURIComponent(userUri)}&count=100`,
  );
  return collection;
}

export interface CalendlyScheduledEvent {
  uri: string;
  name: string;
  status: "active" | "canceled";
  start_time: string;
  end_time: string;
  event_type: string;
  created_at: string;
  updated_at: string;
}

/**
 * Follows next_page_token until exhausted or MAX_PAGES is reached. A bug that produced
 * an endless pagination loop should not be able to run this action forever.
 */
async function paginate<T>(firstUrl: string): Promise<T[]> {
  const MAX_PAGES = 20;
  let url: string | null = firstUrl;
  const out: T[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body: { collection: T[]; pagination?: { next_page_token?: string | null } } =
      await calendlyFetch(url);
    out.push(...body.collection);
    const nextToken = body.pagination?.next_page_token;
    url = nextToken
      ? `${firstUrl}${firstUrl.includes("?") ? "&" : "?"}page_token=${encodeURIComponent(nextToken)}`
      : null;
  }
  return out;
}

/**
 * Active events of one event type, in a bounded upcoming window. Filtering by event_type
 * server-side (where the API supports it, which it does here) means events for any other
 * event type never come down the wire at all.
 */
export async function listActiveEvents(
  userUri: string,
  eventTypeUri: string,
  minStartTime: Date,
  maxStartTime: Date,
): Promise<CalendlyScheduledEvent[]> {
  const params = new URLSearchParams({
    user: userUri,
    event_type: eventTypeUri,
    status: "active",
    min_start_time: minStartTime.toISOString(),
    max_start_time: maxStartTime.toISOString(),
    count: "100",
    sort: "start_time:asc",
  });
  return paginate<CalendlyScheduledEvent>(`/scheduled_events?${params.toString()}`);
}

export interface CalendlyQA {
  question: string;
  answer: string;
  position?: number;
}

export interface CalendlyInvitee {
  uri: string;
  email: string;
  name: string;
  status: "active" | "canceled";
  event: string;
  created_at: string;
  updated_at: string;
  questions_and_answers: CalendlyQA[];
  rescheduled: boolean;
  old_invitee: string | null;
  new_invitee: string | null;
  cancellation: { canceled_at?: string; reason?: string } | null;
}

export async function listInvitees(eventUri: string): Promise<CalendlyInvitee[]> {
  return paginate<CalendlyInvitee>(`${eventUri}/invitees?count=100`);
}

/** Every invitee/event URI is itself a GET-able resource — used for the recheck pass. */
export async function getInvitee(inviteeUri: string): Promise<CalendlyInvitee> {
  const { resource } = await calendlyFetch<{ resource: CalendlyInvitee }>(inviteeUri);
  return resource;
}

export async function getEvent(eventUri: string): Promise<CalendlyScheduledEvent> {
  const { resource } = await calendlyFetch<{ resource: CalendlyScheduledEvent }>(eventUri);
  return resource;
}
