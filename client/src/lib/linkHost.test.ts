import { describe, expect, it } from "vitest";
import { disguisedHost } from "./linkHost";

describe("disguisedHost (#580)", () => {
  it("names the real site when the words are another domain", () => {
    expect(disguisedHost("www.paypal.com", "https://evil.example/")).toBe("evil.example");
    expect(disguisedHost("paypal.com", "https://evil.example/steal")).toBe("evil.example");
    expect(disguisedHost("https://paypal.com/login", "https://evil.example/")).toBe("evil.example");
    expect(disguisedHost("http://paypal.com", "http://evil.example/")).toBe("evil.example");
    expect(disguisedHost("paypal.com:8443/login?next=1", "https://evil.example/")).toBe("evil.example");
    expect(disguisedHost("192.168.1.1", "https://evil.example/")).toBe("evil.example");
    expect(disguisedHost("paypal.com", "https://203.0.113.5/")).toBe("203.0.113.5");
  });

  it("leaves ordinary words alone", () => {
    for (const words of ["the menu", "click here", "this", "v1.2", "3.14", "e.g.", "Saturday night", "paypal", ""]) {
      expect(disguisedHost(words, "https://evil.example/")).toBeNull();
    }
  });

  it("says nothing when the words name the same site", () => {
    expect(disguisedHost("paypal.com", "https://paypal.com/")).toBeNull();
    expect(disguisedHost("www.paypal.com", "https://paypal.com/")).toBeNull();
    expect(disguisedHost("paypal.com", "https://www.paypal.com/x")).toBeNull();
    expect(disguisedHost("PayPal.com", "https://paypal.com/")).toBeNull();
    // A different part of the same site.
    expect(disguisedHost("paypal.com", "https://login.paypal.com/")).toBeNull();
    expect(disguisedHost("login.paypal.com", "https://paypal.com/")).toBeNull();
    // A typed-out address draws as its own link.
    expect(disguisedHost("https://linger.example/porch", "https://linger.example/porch")).toBeNull();
  });

  it("only counts a match at a dot", () => {
    expect(disguisedHost("paypal.com", "https://paypal.com.evil.example/")).toBe("paypal.com.evil.example");
    expect(disguisedHost("paypal.com", "https://notpaypal.com/")).toBe("notpaypal.com");
  });

  it("reads look-alike letters the way the computer does", () => {
    // A Cyrillic а in the words: whatever it looks like, it isn't paypal.com.
    expect(disguisedHost("pаypal.com", "https://paypal.com/")).toBe("paypal.com");
    expect(disguisedHost("https://pаypal.com", "https://pаypal.com/")).toBe("xn--pypal-4ve.com");
    // Full stops from other alphabets are read as dots.
    expect(disguisedHost("paypal。com", "https://evil.example/")).toBe("evil.example");
  });

  it("sees through a user name in front of the host", () => {
    expect(disguisedHost("https://paypal.com@evil.example", "https://paypal.com@evil.example/")).toBe("evil.example");
  });

  it("is about web pages only", () => {
    expect(disguisedHost("paypal.com", "mailto:someone@evil.example")).toBeNull();
    expect(disguisedHost("mailto:someone@paypal.com", "https://evil.example/")).toBeNull();
  });

  it("takes sentence punctuation off the words", () => {
    expect(disguisedHost("paypal.com.", "https://paypal.com/")).toBeNull();
    expect(disguisedHost("paypal.com!", "https://evil.example/")).toBe("evil.example");
  });
});
