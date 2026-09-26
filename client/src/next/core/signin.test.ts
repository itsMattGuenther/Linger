import { describe, expect, it } from "vitest";
import type { AuthResponse } from "../../generated/AuthResponse";
import type { User } from "../../generated/User";
import { type Door, type Entrance, loginReady, problemIn, readPasted, registerReady, setupReady, signInActions, stepFor, usernameOf } from "./signin";

const matt: User = {
  id: "u-matt",
  username: "matt",
  display_name: "Matt",
  is_host: true,
  style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
  status: null,
  entrance_sound: null,
  last_seen_at: null,
};

/** A server at an address that answers the way it's told to, writing down what it was asked. */
function doorThat(answers: { setup?: boolean; invite?: boolean; name?: string | null; down?: string }) {
  const asked: string[] = [];
  const doorAt = (baseUrl: string): Door => ({
    setupPreview: async (token) => {
      asked.push(`${baseUrl} setup ${token}`);
      if (answers.down) throw new Error(answers.down);
      return { valid: answers.setup ?? true };
    },
    invitePreview: async (code) => {
      asked.push(`${baseUrl} invite ${code}`);
      if (answers.down) throw new Error(answers.down);
      return { valid: answers.invite ?? true, server_name: answers.name ?? null };
    },
    health: async () => {
      asked.push(`${baseUrl} health`);
      if (answers.down) throw new Error(answers.down);
    },
  });
  return { asked, doorAt };
}

describe("signing in", () => {
  it("reads what was pasted: an invite, a setup link, or a server", () => {
    expect(readPasted("https://home.example/invite/ABCD-1234")).toEqual({ link: { kind: "invite", baseUrl: "https://home.example", code: "ABCD-1234" } });
    expect(readPasted("https://home.example/setup?token=t0k")).toEqual({ link: { kind: "setup", baseUrl: "https://home.example", token: "t0k" } });
    expect(readPasted("home.example")).toEqual({ link: { kind: "server", baseUrl: "https://home.example" } });
    expect(readPasted("   ")).toEqual({ problem: "That doesn't look like a server address or a link." });
    expect(readPasted("ftp://home.example")).toHaveProperty("problem");
  });

  it("keeps a username the way the server does", () => {
    expect(usernameOf("  Matt ")).toBe("matt");
  });

  it("only lets a form go once it has what it needs", () => {
    expect(loginReady(" ", "x")).toBe(false);
    expect(loginReady("matt", "")).toBe(false);
    expect(loginReady("matt", "x")).toBe(true);
    expect(registerReady("matt", "Matt", "1234567")).toBe(false);
    expect(registerReady("matt", "  ", "12345678")).toBe(false);
    expect(registerReady("matt", "Matt", "12345678")).toBe(true);
    expect(setupReady(" ", "matt", "Matt", "12345678")).toBe(false);
    expect(setupReady("The Good Company", "matt", "Matt", "12345678")).toBe(true);
  });

  it("a working setup link leads to setting the server up; a used one says so", async () => {
    const ok = doorThat({});
    expect(await stepFor("https://home.example/setup?token=t0k", ok.doorAt)).toEqual({ step: { kind: "setup", baseUrl: "https://home.example", token: "t0k" } });
    expect(ok.asked).toEqual(["https://home.example setup t0k"]);
    expect(await stepFor("https://home.example/setup?token=t0k", doorThat({ setup: false }).doorAt)).toEqual({
      problem: "That setup link has already been used. Restart the server for a new one.",
    });
  });

  it("a live invite leads to joining, named for its server; a dead one says so", async () => {
    const ok = doorThat({ name: "The Good Company" });
    expect(await stepFor("https://home.example/invite/ABCD", ok.doorAt)).toEqual({
      step: { kind: "register", baseUrl: "https://home.example", code: "ABCD", serverName: "The Good Company" },
    });
    expect(ok.asked).toEqual(["https://home.example invite ABCD"]);
    expect(await stepFor("https://home.example/invite/ABCD", doorThat({ invite: false }).doorAt)).toEqual({
      problem: "That invite isn't good anymore. Ask for a new one.",
    });
  });

  it("a bare address leads to signing in once something answers there", async () => {
    const ok = doorThat({});
    expect(await stepFor("home.example", ok.doorAt)).toEqual({ step: { kind: "login", baseUrl: "https://home.example", serverName: null } });
    expect(ok.asked).toEqual(["https://home.example health"]);
  });

  it("says what went wrong in words, and asks nobody about something that isn't an address", async () => {
    expect(await stepFor("home.example", doorThat({ down: "Couldn't reach home.example." }).doorAt)).toEqual({ problem: "Couldn't reach home.example." });
    const none = doorThat({});
    expect(await stepFor("not a link", none.doorAt)).toEqual({ problem: "That doesn't look like a server address or a link." });
    expect(none.asked).toEqual([]);
    expect(problemIn("thrown string")).toBe("Something went wrong.");
    expect(problemIn(new Error(""))).toBe("Something went wrong.");
  });

  it("sends what was typed the way the server keeps it, keeps a sign-in that works, and says why one didn't", async () => {
    const sent: unknown[] = [];
    const kept: string[] = [];
    const auth: AuthResponse = { access_token: "a", refresh_token: "r", expires_in: 900, user: matt };
    let refuse: string | null = null;
    const entrance: Entrance = {
      ...doorThat({}).doorAt("https://home.example"),
      login: async (request) => {
        sent.push(["login", request]);
        if (refuse) throw new Error(refuse);
        return auth;
      },
      register: async (request) => {
        sent.push(["register", request]);
        return auth;
      },
      setup: async (request) => {
        sent.push(["setup", request]);
        return auth;
      },
    };
    const actions = signInActions(
      () => entrance,
      async (baseUrl, got) => {
        expect(got).toBe(auth);
        kept.push(baseUrl);
      },
    );

    expect(await actions.login("https://home.example", "  Matt ", " pass word ")).toBeNull();
    expect(await actions.register("https://home.example", "ABCD", "Jules ", " Jules R. ", "12345678")).toBeNull();
    expect(await actions.setup("https://home.example", "t0k", " The Good Company ", "MATT", "Matt", "12345678")).toBeNull();
    expect(sent).toEqual([
      // A password is sent exactly as typed, spaces and all.
      ["login", { username: "matt", password: " pass word " }],
      ["register", { invite_code: "ABCD", username: "jules", display_name: "Jules R.", password: "12345678" }],
      ["setup", { token: "t0k", server_name: "The Good Company", username: "matt", display_name: "Matt", password: "12345678" }],
    ]);
    expect(kept).toEqual(["https://home.example", "https://home.example", "https://home.example"]);

    refuse = "That username and password don't match.";
    expect(await actions.login("https://home.example", "matt", "nope")).toBe("That username and password don't match.");
    expect(kept).toHaveLength(3);
  });

  it("a sign-in the computer can't keep says why", async () => {
    const auth: AuthResponse = { access_token: "a", refresh_token: "r", expires_in: 900, user: matt };
    const actions = signInActions(
      () => ({ ...doorThat({}).doorAt("https://home.example"), login: async () => auth, register: async () => auth, setup: async () => auth }),
      async () => {
        throw new Error("The keyring is locked.");
      },
    );
    expect(await actions.login("https://home.example", "matt", "x")).toBe("The keyring is locked.");
  });
});
