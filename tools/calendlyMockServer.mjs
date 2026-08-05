#!/usr/bin/env node
/* A minimal stand-in for the Calendly API v2, built from the same field names and
   pagination/URI conventions convex/calendlyClient.ts expects. Lets the sync pipeline be
   tested end-to-end — real HTTP, real Convex actions — without a real Calendly account.
   See docs/CALENDLY_FREE_SYNC.md "Testing without a real booking". */
import { createServer } from 'http';
import { networkInterfaces } from 'os';

/* The Convex local backend does not share this machine's loopback interface — a mock
   bound to 127.0.0.1 gets an immediate connection reset from it, even though the exact
   same server answers curl and Node's own fetch() on 127.0.0.1 without trouble. Binding
   to the LAN interface and addressing the mock by that IP instead sidesteps whatever
   network boundary the backend runs behind. */
function hostLanAddress() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1'; // fallback: no LAN interface found
}

export function startMockCalendly() {
  const state = {
    token: 'mock-token-for-testing',
    enforceAuth: true,
    forceRateLimitOnce: false,
    pageSize: 100, // set to 1 to exercise pagination
    user: { uri: '', name: 'Aasim Ahmed', email: 'aasim@adscade.com', organization: '' },
    eventTypes: [], // [{uri, name, active}]
    events: new Map(), // uri -> {uri, name, status, start_time, end_time, event_type, created_at, updated_at}
    invitees: new Map(), // uri -> {uri, email, name, status, event, created_at, updated_at, questions_and_answers, rescheduled, old_invitee, new_invitee, cancellation}
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers['authorization'] || '';

    if (state.enforceAuth && auth !== `Bearer ${state.token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'invalid token' }));
      return;
    }
    if (state.forceRateLimitOnce) {
      state.forceRateLimitOnce = false;
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'rate limited' }));
      return;
    }

    const send = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const paginated = (all) => {
      const token = url.searchParams.get('page_token');
      const start = token ? parseInt(token, 10) : 0;
      const page = all.slice(start, start + state.pageSize);
      const next = start + state.pageSize < all.length ? String(start + state.pageSize) : null;
      return { collection: page, pagination: { next_page_token: next } };
    };

    if (url.pathname === '/users/me') return send({ resource: state.user });

    if (url.pathname === '/event_types') return send(paginated(state.eventTypes));

    if (url.pathname === '/scheduled_events') {
      const eventType = url.searchParams.get('event_type');
      const status = url.searchParams.get('status');
      const minStart = url.searchParams.get('min_start_time');
      const maxStart = url.searchParams.get('max_start_time');
      let all = [...state.events.values()];
      if (eventType) all = all.filter((e) => e.event_type === eventType);
      if (status) all = all.filter((e) => e.status === status);
      if (minStart) all = all.filter((e) => e.start_time >= minStart);
      if (maxStart) all = all.filter((e) => e.start_time <= maxStart);
      all.sort((a, b) => a.start_time.localeCompare(b.start_time));
      return send(paginated(all));
    }

    const inviteesMatch = url.pathname.match(/^\/scheduled_events\/([^/]+)\/invitees$/);
    if (inviteesMatch) {
      const eventUri = `${state.base}/scheduled_events/${inviteesMatch[1]}`;
      const all = [...state.invitees.values()].filter((i) => i.event === eventUri);
      return send(paginated(all));
    }

    const eventMatch = url.pathname.match(/^\/scheduled_events\/([^/]+)$/);
    if (eventMatch) {
      const ev = state.events.get(url.pathname);
      if (!ev) return send({ message: 'not found' }, 404);
      return send({ resource: ev });
    }

    const inviteeMatch = url.pathname.match(/^\/invitees\/([^/]+)$/);
    if (inviteeMatch) {
      const inv = state.invitees.get(url.pathname);
      if (!inv) return send({ message: 'not found' }, 404);
      return send({ resource: inv });
    }

    send({ message: 'no route: ' + url.pathname }, 404);
  });

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const port = server.address().port;
      const base = `http://${hostLanAddress()}:${port}`;
      state.base = base;
      state.user.uri = `${base}/users/me/self`;
      state.user.organization = `${base}/organizations/org-1`;
      resolve({
        base,
        state,
        stop: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Helpers to build fixtures with correctly-shaped, base-prefixed URIs. */
export function mockFixtures(base) {
  let n = 0;
  const nextId = (prefix) => `${prefix}-${++n}`;
  return {
    eventType(name) {
      return { uri: `${base}/event_types/${nextId('et')}`, name, active: true };
    },
    event(eventTypeUri, { startTime, endTime, status = 'active' }) {
      const uri = `${base}/scheduled_events/${nextId('evt')}`;
      const now = new Date().toISOString();
      return {
        uri,
        name: 'Real Estate Acquisition System Call',
        status,
        start_time: startTime,
        end_time: endTime,
        event_type: eventTypeUri,
        created_at: now,
        updated_at: now,
      };
    },
    invitee(eventUri, { email, name, status = 'active', qa = [] }) {
      const uri = `${base}/invitees/${nextId('inv')}`;
      const now = new Date().toISOString();
      return {
        uri,
        email,
        name,
        status,
        event: eventUri,
        created_at: now,
        updated_at: now,
        questions_and_answers: qa,
        rescheduled: false,
        old_invitee: null,
        new_invitee: null,
        cancellation: null,
      };
    },
  };
}

// Allow running standalone for manual poking: node tools/calendlyMockServer.mjs
if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const { base, state } = await startMockCalendly();
  console.log('mock Calendly listening at', base);
  console.log('set in Convex:');
  console.log(`  npx convex env set CALENDLY_API_BASE ${base}`);
  console.log(`  npx convex env set CALENDLY_PAT ${state.token}`);
}
