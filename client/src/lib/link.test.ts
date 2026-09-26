import { describe, expect, it } from "vitest";
import { parsePastedLink } from "./link";

describe("reading what was pasted into the sign-in box", () => {
  it("understands a server, an invite and a setup link", () => {
    expect(parsePastedLink("linger.example")).toEqual({ kind: "server", baseUrl: "https://linger.example" });
    expect(parsePastedLink("  http://localhost:8080 ")).toEqual({ kind: "server", baseUrl: "http://localhost:8080" });
    expect(parsePastedLink("http://[::1]:8080")).toEqual({ kind: "server", baseUrl: "http://[::1]:8080" });
    expect(parsePastedLink("https://linger.example/invite/AB-12")).toEqual({ kind: "invite", baseUrl: "https://linger.example", code: "AB-12" });
    expect(parsePastedLink("https://linger.example/invite?code=AB-12")).toEqual({ kind: "invite", baseUrl: "https://linger.example", code: "AB-12" });
    expect(parsePastedLink("https://linger.example/setup?token=t0k")).toEqual({ kind: "setup", baseUrl: "https://linger.example", token: "t0k" });
    expect(parsePastedLink("linger_box.lan:8080")).toEqual({ kind: "server", baseUrl: "https://linger_box.lan:8080" });
    // An international name, as the parser spells it.
    expect(parsePastedLink("bücher.example")).toEqual({ kind: "server", baseUrl: "https://xn--bcher-kva.example" });
  });

  it("refuses a sentence, a different kind of link, and nothing", () => {
    expect(parsePastedLink("not a link")).toBeNull();
    expect(parsePastedLink("linger.example is the address")).toBeNull();
    expect(parsePastedLink("ftp://linger.example")).toBeNull();
    expect(parsePastedLink("   ")).toBeNull();
    expect(parsePastedLink("https://")).toBeNull();
    // Hosts one parser lets through and another doesn't.
    expect(parsePastedLink("linger!.example")).toBeNull();
    expect(parsePastedLink("https://a$b.example/invite/X")).toBeNull();
  });
});
