// Per-IP rate limiting for api/contact.js.
//
// HONEST LIMITATION — read before relying on this for anything but a basic
// deterrent: this is an IN-MEMORY, PER-SERVERLESS-INSTANCE limiter. Each
// warm Vercel function instance keeps its own independent counters in
// process memory. That means:
//   - A cold start (new instance) resets everyone's count to zero.
//   - Vercel can and does run multiple warm instances concurrently under
//     load, each with its own counters — a client can get several times the
//     nominal limit just by having requests land on different instances.
//   - A distributed attacker (many source IPs, e.g. a botnet) is not slowed
//     at all — this only throttles ONE IP hammering repeatedly.
// This is proportionate to the actual threat named in the brief ("a
// deliberate script can flood the owner's inbox") — it stops the cheap,
// common case (one script, one IP, looping) — but it is NOT a durable or
// distributed rate limit. A durable limit shared across every instance and
// every IP would need a shared store such as Vercel KV (Upstash Redis) —
// that is a new paid dependency and provisioning it is the owner's call, not
// made here.
//
// getClientIp() reads the header Vercel's edge network sets on every
// request reaching a Node.js serverless function: x-forwarded-for. (There
// is no prior art for this in the codebase to reuse — grepped api/ and lib/
// for x-forwarded-for / x-real-ip / req.socket.remoteAddress and found
// nothing already doing IP extraction; this is the first.) The header can
// carry a comma-separated chain (client, proxy1, proxy2, ...) appended to by
// each hop; Vercel prepends the true client IP as the first entry, so only
// that first entry is trusted — anything after it could be forged by the
// client itself.
export function getClientIp(req) {
  const headers = (req && req.headers) || {};
  const forwardedFor = headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIp = headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return 'unknown';
}

/**
 * Sliding-window-log limiter keyed by an arbitrary string (the client IP).
 * `windowMs` / `max` chosen for /api/contact specifically — see the comment
 * at the call site in api/contact.js for the rationale on the numbers.
 * `now` is injectable so tests can move time forward without a real sleep;
 * defaults to the real clock.
 */
export function createRateLimiter({ windowMs = 10 * 60 * 1000, max = 5, now = () => Date.now() } = {}) {
  const hits = new Map(); // key -> array of request timestamps, oldest first

  return {
    /** Records this call as an attempt and returns whether it is allowed.
     * Never throws. `allowed: false` comes with `retryAfterMs`, the time
     * until the oldest hit in the current window falls out of it. */
    check(key) {
      const t = now();
      const windowStart = t - windowMs;
      const existing = hits.get(key) || [];
      const inWindow = existing.filter((ts) => ts > windowStart);

      if (inWindow.length >= max) {
        hits.set(key, inWindow);
        const retryAfterMs = inWindow[0] + windowMs - t;
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
      }

      inWindow.push(t);
      hits.set(key, inWindow);
      return { allowed: true, remaining: max - inWindow.length };
    },

    /** For diagnostics/tests only — not used on the request path. */
    _size() {
      return hits.size;
    },
  };
}
