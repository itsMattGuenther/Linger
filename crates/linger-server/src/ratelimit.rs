//! Keyed token buckets for the ARCHITECTURE §7 rate limits (constants in
//! `linger-core::limits`). In-memory on purpose: limits reset on restart, which
//! is harmless at this scale and keeps the database out of the hot path.
//!
//! Only keys that are still refilling are remembered. A bucket that has
//! refilled is the same as no bucket (new ones start full), so it is
//! forgotten on the next sweep (#546). Before, the map grew by one entry for
//! every address, user and room it ever saw, for the life of the process.

use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dashmap::DashMap;

/// How often [`RateLimiter::check`] clears out buckets that have refilled.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

struct Bucket {
    tokens: f64,
    last_refill: Instant,
    /// When the bucket is back to full, and so the same as having none.
    full_at: Instant,
}

impl Bucket {
    /// Note when `tokens` (as of `last_refill`) will have refilled to
    /// `capacity` at `rate_per_sec`.
    fn update_full_at(&mut self, capacity: f64, rate_per_sec: f64) {
        let missing = (capacity - self.tokens).max(0.0);
        self.full_at = self.last_refill + Duration::from_secs_f64(missing / rate_per_sec);
    }
}

pub struct RateLimiter {
    buckets: DashMap<String, Bucket>,
    /// When the next sweep is due. A `try_lock` miss means another request
    /// is looking at it this moment, which is as good as sweeping.
    next_sweep: Mutex<Instant>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            buckets: DashMap::new(),
            next_sweep: Mutex::new(Instant::now() + SWEEP_EVERY),
        }
    }
}

/// The key a per-address limit counts against, given `auth::client_ip`'s
/// answer.
///
/// An IPv4 address is its own key. An IPv6 address counts by its /64 (#546):
/// a home connection or a VPS is handed a whole /64, so counted per address,
/// one person could step through 18 quintillion of them and never meet a
/// limit. Anything that isn't an address (`"unknown"`) is kept as it is.
#[must_use]
pub fn address_key(address: &str) -> String {
    match address.parse::<IpAddr>().map(|ip| ip.to_canonical()) {
        Ok(IpAddr::V6(v6)) => {
            let [a, b, c, d, ..] = v6.segments();
            format!("{a:x}:{b:x}:{c:x}:{d:x}::/64")
        }
        Ok(IpAddr::V4(v4)) => v4.to_string(),
        Err(_) => address.to_string(),
    }
}

impl RateLimiter {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Try to take one token from the bucket for `key`, where `limit` is
    /// `(events, per_seconds)`. On denial returns the milliseconds until a
    /// token is available, for the `retry_after_ms` field.
    ///
    /// Buckets start full, so bursts up to `events` are fine — that matches how
    /// the limits are phrased ("10 per 10s"), and friends aren't attackers.
    pub fn check(&self, key: &str, limit: (u32, u64)) -> Result<(), u64> {
        let (events, per_seconds) = limit;
        let capacity = f64::from(events);
        let rate_per_sec = capacity / per_seconds as f64;
        let now = Instant::now();
        self.sweep_if_due(now);

        let mut bucket = self.buckets.entry(key.to_string()).or_insert(Bucket {
            tokens: capacity,
            last_refill: now,
            full_at: now,
        });

        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate_per_sec).min(capacity);
        bucket.last_refill = now;

        let taken = if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let missing = 1.0 - bucket.tokens;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Err((missing / rate_per_sec * 1000.0).ceil() as u64)
        };
        bucket.update_full_at(capacity, rate_per_sec);
        taken
    }

    /// Give back the token a [`check`](Self::check) just took, for an action
    /// that turned out not to happen.
    ///
    /// Taking first and refunding on refusal, rather than asking first and
    /// taking later, keeps the limit race-free: two requests at once can't
    /// both see a token and both go ahead. Never above the bucket's capacity.
    pub fn refund(&self, key: &str, limit: (u32, u64)) {
        if let Some(mut bucket) = self.buckets.get_mut(key) {
            let capacity = f64::from(limit.0);
            bucket.tokens = (bucket.tokens + 1.0).min(capacity);
            bucket.update_full_at(capacity, capacity / limit.1 as f64);
        }
    }

    /// Sweep if a minute has passed since the last sweep. [`check`](Self::check)
    /// calls this before it takes its own bucket: holding one while the map
    /// is swept would wait on itself.
    fn sweep_if_due(&self, now: Instant) {
        let Ok(mut next) = self.next_sweep.try_lock() else {
            return;
        };
        if now < *next {
            return;
        }
        *next = now + SWEEP_EVERY;
        drop(next);
        self.forget_refilled(now);
    }

    /// Forget every bucket that is full again by `now`.
    fn forget_refilled(&self, now: Instant) {
        self.buckets.retain(|_, bucket| bucket.full_at > now);
    }

    /// How many keys are remembered, for tests.
    #[cfg(test)]
    fn remembered(&self) -> usize {
        self.buckets.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_burst_then_denies_with_retry_hint() {
        let rl = RateLimiter::new();
        for _ in 0..5 {
            assert!(rl.check("login:1.2.3.4", (5, 60)).is_ok());
        }
        let retry = rl.check("login:1.2.3.4", (5, 60)).unwrap_err();
        // One token refills every 12s; the hint must be in that ballpark.
        assert!(
            retry > 10_000 && retry <= 12_000,
            "retry_after_ms was {retry}"
        );
    }

    #[test]
    fn keys_are_independent() {
        let rl = RateLimiter::new();
        for _ in 0..5 {
            assert!(rl.check("login:a", (5, 60)).is_ok());
        }
        assert!(rl.check("login:a", (5, 60)).is_err());
        assert!(rl.check("login:b", (5, 60)).is_ok());
    }

    #[test]
    fn a_refund_gives_back_one_token_and_no_more() {
        let rl = RateLimiter::new();
        assert!(rl.check("k", (1, 3_600)).is_ok());
        assert!(rl.check("k", (1, 3_600)).is_err());
        rl.refund("k", (1, 3_600));
        assert!(rl.check("k", (1, 3_600)).is_ok());
        assert!(rl.check("k", (1, 3_600)).is_err());
        // A full bucket stays full: refunding twice is not a second token.
        let full = RateLimiter::new();
        assert!(full.check("k", (1, 3_600)).is_ok());
        full.refund("k", (1, 3_600));
        full.refund("k", (1, 3_600));
        assert!(full.check("k", (1, 3_600)).is_ok());
        assert!(full.check("k", (1, 3_600)).is_err());
        // A key it never took from is left alone.
        rl.refund("never", (1, 3_600));
    }

    #[test]
    fn tokens_refill_over_time() {
        let rl = RateLimiter::new();
        assert!(rl.check("k", (1, 1)).is_ok());
        assert!(rl.check("k", (1, 1)).is_err());
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert!(rl.check("k", (1, 1)).is_ok());
    }

    #[test]
    fn an_ipv6_slash_64_shares_one_allowance() {
        // Two addresses one home connection could hand out.
        let a = address_key("2001:db8:1:2::7");
        let b = address_key("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
        assert_eq!(a, "2001:db8:1:2::/64");
        assert_eq!(a, b);
        let rl = RateLimiter::new();
        for _ in 0..5 {
            assert!(rl.check(&format!("login:{a}"), (5, 60)).is_ok());
        }
        assert!(rl.check(&format!("login:{b}"), (5, 60)).is_err());
        // The next /64 over is somebody else.
        let c = address_key("2001:db8:1:3::7");
        assert!(rl.check(&format!("login:{c}"), (5, 60)).is_ok());
    }

    #[test]
    fn an_ipv4_address_and_anything_else_count_as_themselves() {
        assert_eq!(address_key("203.0.113.7"), "203.0.113.7");
        assert_ne!(address_key("203.0.113.7"), address_key("203.0.113.8"));
        // An IPv4 address written the IPv6 way is still itself, not a /64
        // shared with every IPv4 address there is.
        assert_eq!(address_key("::ffff:203.0.113.7"), "203.0.113.7");
        assert_eq!(address_key("unknown"), "unknown");
    }

    #[test]
    fn a_key_is_forgotten_once_its_bucket_has_refilled() {
        let rl = RateLimiter::new();
        assert!(rl.check("login:a", (5, 60)).is_ok());
        assert!(rl.check("search:b", (1, 1)).is_ok());
        assert_eq!(rl.remembered(), 2);
        let now = Instant::now();
        // Still refilling: both stay, or forgetting one would hand out a
        // fresh allowance early.
        rl.forget_refilled(now);
        assert_eq!(rl.remembered(), 2);
        // One token a second: full again after a second, so forgotten.
        rl.forget_refilled(now + Duration::from_secs(2));
        assert_eq!(rl.remembered(), 1);
        // One token every 12 s.
        rl.forget_refilled(now + Duration::from_secs(13));
        assert_eq!(rl.remembered(), 0);
    }

    #[test]
    fn a_refused_key_is_remembered_until_it_has_refilled() {
        let rl = RateLimiter::new();
        assert!(rl.check("k", (1, 10)).is_ok());
        assert!(rl.check("k", (1, 10)).is_err());
        let now = Instant::now();
        rl.forget_refilled(now + Duration::from_secs(9));
        assert_eq!(rl.remembered(), 1);
        rl.forget_refilled(now + Duration::from_secs(11));
        assert_eq!(rl.remembered(), 0);
    }

    #[test]
    fn a_refund_that_fills_the_bucket_lets_it_be_forgotten() {
        let rl = RateLimiter::new();
        assert!(rl.check("k", (1, 3_600)).is_ok());
        rl.refund("k", (1, 3_600));
        rl.forget_refilled(Instant::now() + Duration::from_millis(1));
        assert_eq!(rl.remembered(), 0);
    }

    #[test]
    fn checking_sweeps_once_a_minute() {
        let rl = RateLimiter::new();
        assert!(rl.check("a", (1, 1)).is_ok());
        // Not due yet: the refilled bucket stays until the minute is up.
        rl.sweep_if_due(Instant::now() + Duration::from_secs(2));
        assert_eq!(rl.remembered(), 1);
        rl.sweep_if_due(Instant::now() + SWEEP_EVERY + Duration::from_secs(1));
        assert_eq!(rl.remembered(), 0);
    }
}
