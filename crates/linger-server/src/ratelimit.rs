//! Keyed token buckets for the ARCHITECTURE §7 rate limits (constants in
//! `linger-core::limits`). In-memory on purpose: limits reset on restart, which
//! is harmless at this scale and keeps the database out of the hot path.

use std::time::Instant;

use dashmap::DashMap;

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: DashMap<String, Bucket>,
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

        let mut bucket = self.buckets.entry(key.to_string()).or_insert(Bucket {
            tokens: capacity,
            last_refill: now,
        });

        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate_per_sec).min(capacity);
        bucket.last_refill = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let missing = 1.0 - bucket.tokens;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Err((missing / rate_per_sec * 1000.0).ceil() as u64)
        }
    }

    /// Give back the token a [`check`](Self::check) just took, for an action
    /// that turned out not to happen.
    ///
    /// Taking first and refunding on refusal, rather than asking first and
    /// taking later, keeps the limit race-free: two requests at once can't
    /// both see a token and both go ahead. Never above the bucket's capacity.
    pub fn refund(&self, key: &str, limit: (u32, u64)) {
        if let Some(mut bucket) = self.buckets.get_mut(key) {
            bucket.tokens = (bucket.tokens + 1.0).min(f64::from(limit.0));
        }
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
}
