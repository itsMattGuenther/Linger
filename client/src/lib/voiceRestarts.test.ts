import { describe, expect, it } from "vitest";

import { DISCONNECTED_FOR_MS, RESTART_AFTER_MS, type RestartEvent, type RestartPlan, Restarts } from "./voiceRestarts";

// The same cases as the desktop engine's rules (src-tauri/src/voice/restart.rs):
// the phone's voice must start its connection afresh exactly as often (#429).

/** A call, and a clock that only moves when the test says. Times in seconds. */
class Call {
  rules = new Restarts();
  /** When each restart was asked for. */
  restarts: number[] = [];

  at(seconds: number, event: RestartEvent): RestartPlan {
    const plan = this.rules.on(event, seconds * 1000);
    if (plan.restart) this.restarts.push(seconds);
    return plan;
  }

  /** Let the clock run to `until`, waking whenever a plan asked to, as the engine's loop does. */
  runTo(until: number, plan: RestartPlan) {
    while (plan.wake !== null) {
      const at = plan.wake / 1000;
      if (at > until) return;
      plan = this.at(at, "tick");
    }
  }
}

describe("when the phone's voice connection starts afresh", () => {
  it("leaves a short disconnect that comes back alone", () => {
    const call = new Call();
    const plan = call.at(10, "disconnected");
    expect(plan.wake).toBe(10_000 + DISCONNECTED_FOR_MS);
    call.runTo(60, call.at(11.5, "connected"));
    expect(call.restarts).toEqual([]);
  });

  it("restarts a disconnect that lasts, once", () => {
    const call = new Call();
    const plan = call.at(10, "disconnected");
    call.at(11, "disconnected");
    call.runTo(12.5, plan);
    expect(call.restarts).toEqual([12]);
    call.runTo(60, call.at(12.2, "answered"));
    expect(call.restarts).toEqual([12]);
  });

  it("restarts a failed connection at once", () => {
    const call = new Call();
    expect(call.at(10, "failed").restart).toBe(true);
    call.runTo(60, call.at(10.2, "answered"));
    expect(call.restarts).toEqual([10]);
  });

  it("restarts at once when the gateway resumes, even with the connection up", () => {
    const call = new Call();
    call.at(1, "answered");
    call.at(2, "connected");
    expect(call.at(30, "gateway-resumed").restart).toBe(true);
    call.runTo(60, call.at(30.1, "answered"));
    expect(call.restarts).toEqual([30]);
  });

  it("asks for nothing else while one is in flight", () => {
    const call = new Call();
    expect(call.at(10, "failed").restart).toBe(true);
    expect(call.at(10.5, "gateway-resumed").restart).toBe(false);
    expect(call.at(11, "failed").restart).toBe(false);
    expect(call.at(11.5, "disconnected").restart).toBe(false);
    call.runTo(60, call.at(12, "answered"));
    expect(call.restarts).toEqual([10]);
  });

  it("asks again for a restart nobody answered", () => {
    const call = new Call();
    call.runTo(17, call.at(10, "failed"));
    expect(call.restarts).toEqual([10, 13, 16]);
    call.runTo(60, call.at(16.1, "answered"));
    expect(call.restarts).toHaveLength(3);
  });

  it("never restarts closer together than the gap", () => {
    const call = new Call();
    let plan = call.at(0, "failed");
    for (let t = 0.25; t <= 30; t += 0.25) {
      call.runTo(t, plan);
      // The server answers each restart at once, and the new connection fails at once.
      call.at(t, "answered");
      plan = call.at(t, "failed");
    }
    call.runTo(30, plan);
    expect(call.restarts.length).toBeGreaterThan(5);
    for (let i = 1; i < call.restarts.length; i++) {
      expect((call.restarts[i]! - call.restarts[i - 1]!) * 1000).toBeGreaterThanOrEqual(RESTART_AFTER_MS);
    }
  });

  it("drops a restart waiting on the gap if the connection comes back", () => {
    const call = new Call();
    expect(call.at(10, "failed").restart).toBe(true);
    call.at(10.2, "answered");
    expect(call.at(11, "gateway-resumed")).toEqual({ restart: false, wake: 10_000 + RESTART_AFTER_MS });
    call.runTo(60, call.at(12, "connected"));
    expect(call.restarts).toEqual([10]);

    // Without the connection coming back, it goes when the gap is out.
    const again = new Call();
    again.at(10, "failed");
    again.at(10.2, "answered");
    again.runTo(14, again.at(11, "gateway-resumed"));
    expect(again.restarts).toEqual([10, 13]);
    again.runTo(60, again.at(13.2, "answered"));
    expect(again.restarts).toEqual([10, 13]);
  });

  it("leaves a healthy call alone", () => {
    const call = new Call();
    expect(call.at(1, "answered")).toEqual({ restart: false, wake: null });
    expect(call.at(2, "connected")).toEqual({ restart: false, wake: null });
  });
});
