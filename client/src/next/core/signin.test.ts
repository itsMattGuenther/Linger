import { describe, expect, it } from "vitest";
import type { AuthResponse } from "../../generated/AuthResponse";
import type { User } from "../../generated/User";
import { ApiError } from "../../lib/api";
import {
  type Door,
  type Entrance,
  keyringWords,
  loginReady,
  newPasswordReady,
  problemIn,
  readPasted,
  registerReady,
  setupReady,
  signInActions,
  stepFor,
  usernameOf,
} from "./signin";

const matt: User = {
  id: "u-matt",
  username: "matt",
  display_name: "Matt",
  is_host: true,
  is_cohost: false,
  style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
  status: null,
  entrance_sound: null,
  last_seen_at: null,
};

/** A server at an address that answers the way it's told to, writing down what it was asked. */
function doorThat(answers: { setup?: boolean; invite?: boolean; signIn?: boolean; name?: string | null; down?: string }) {
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
    signInLinkPreview: async (code) => {
      asked.push(`${baseUrl} sign-in ${code}`);
      if (answers.down) throw new Error(answers.down);
      const valid = answers.signIn ?? true;
      return { valid, server_name: valid ? (answers.name ?? null) : null, username: valid ? "sam" : null, made_by: valid ? "Matt" : null };
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
    expect(registerReady("matt", "Ma\u{200B}tt", "12345678")).toBe(false);
    expect(registerReady("matt", "Matt", "12345678")).toBe(true);
    expect(setupReady(" ", "matt", "Matt", "12345678")).toBe(false);
    expect(setupReady("The Good Company", "matt", "Matt", "12345678")).toBe(true);
    expect(newPasswordReady("1234567")).toBe(false);
    expect(newPasswordReady("12345678")).toBe(true);
  });

  it("a working sign-in link leads to choosing a new password for its account; a dead one says so (#581)", async () => {
    expect(readPasted("https://home.example/sign-in/abcd2345")).toEqual({ link: { kind: "signin", baseUrl: "https://home.example", code: "abcd2345" } });
    const ok = doorThat({ name: "The Good Company" });
    expect(await stepFor("https://home.example/sign-in/abcd2345", ok.doorAt)).toEqual({
      step: { kind: "newPassword", baseUrl: "https://home.example", code: "abcd2345", serverName: "The Good Company", username: "sam", madeBy: "Matt" },
    });
    expect(ok.asked).toEqual(["https://home.example sign-in abcd2345"]);
    expect(await stepFor("https://home.example/sign-in/abcd2345", doorThat({ signIn: false }).doorAt)).toEqual({
      problem: "That sign-in link doesn't work any more. It works once, for a day. Ask the host for a new one.",
    });
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
      redeemSignInLink: async (request) => {
        sent.push(["sign-in link", request]);
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
    expect(await actions.newPassword("https://home.example", "abcd2345", " new pass ")).toBeNull();
    expect(sent).toEqual([
      // A password is sent exactly as typed, spaces and all.
      ["login", { username: "matt", password: " pass word " }],
      ["register", { invite_code: "ABCD", username: "jules", display_name: "Jules R.", password: "12345678" }],
      ["setup", { token: "t0k", server_name: "The Good Company", username: "matt", display_name: "Matt", password: "12345678" }],
      ["sign-in link", { code: "abcd2345", new_password: " new pass " }],
    ]);
    expect(kept).toEqual(["https://home.example", "https://home.example", "https://home.example", "https://home.example"]);

    refuse = "That username and password don't match.";
    expect(await actions.login("https://home.example", "matt", "nope")).toBe("That username and password don't match.");
    expect(kept).toHaveLength(4);
  });

  it("joining with a name that looks like somebody's already there says so on the name, and nothing else does (#574)", async () => {
    const LOOKS_TAKEN = "Someone here already goes by a name that looks like that. Try something a little different.";
    let refusal: Error = new ApiError(409, { code: "DISPLAY_NAME_TAKEN", message: LOOKS_TAKEN, retry_after_ms: null });
    const kept: string[] = [];
    const actions = signInActions(
      () => ({
        ...doorThat({}).doorAt("https://home.example"),
        login: async () => Promise.reject(refusal),
        register: async () => Promise.reject(refusal),
        setup: async () => Promise.reject(refusal),
        redeemSignInLink: async () => Promise.reject(refusal),
      }),
      async (baseUrl) => {
        kept.push(baseUrl);
      },
    );
    expect(await actions.register("https://home.example", "ABCD", "callie", "Matt", "12345678")).toEqual({ onName: LOOKS_TAKEN });
    // Any other refusal is the form's, in the server's words.
    refusal = new ApiError(409, { code: "CONFLICT", message: "That username is taken.", retry_after_ms: null });
    expect(await actions.register("https://home.example", "ABCD", "matt", "Callie", "12345678")).toBe("That username is taken.");
    refusal = new ApiError(422, { code: "INVITE_INVALID", message: "That invite isn't valid.", retry_after_ms: null });
    expect(await actions.register("https://home.example", "ABCD", "callie", "Callie", "12345678")).toBe("That invite isn't valid.");
    expect(kept).toEqual([]);
  });

  it("a sign-in the computer can't keep says why", async () => {
    const auth: AuthResponse = { access_token: "a", refresh_token: "r", expires_in: 900, user: matt };
    const actions = signInActions(
      () => ({
        ...doorThat({}).doorAt("https://home.example"),
        login: async () => auth,
        register: async () => auth,
        setup: async () => auth,
        redeemSignInLink: async () => auth,
      }),
      async () => {
        throw new Error("The keyring is locked.");
      },
    );
    expect(await actions.login("https://home.example", "matt", "x")).toBe("The keyring is locked.");
  });

  it("a device that can't keep a sign-in says what that means in plain words, and on Linux how to fix it (#702)", () => {
    expect(keyringWords("this computer", false)).toBe("Linger can't remember your sign-in on this computer, so you'll sign in each time it starts.");
    expect(keyringWords("this phone", false)).toBe("Linger can't remember your sign-in on this phone, so you'll sign in each time it starts.");
    expect(keyringWords("this computer", true)).toBe(
      "Linger can't remember your sign-in on this computer, so you'll sign in each time it starts. Turning on a keyring, such as GNOME Keyring or KWallet, fixes that.",
    );
  });

  it("says nothing a screenshot check would read as the app being broken (#702)", () => {
    // What the AppImage catalog's test flags on a first screen
    // (appimage.github.io code/check-screenshot.sh, its HARD and SOFT words).
    const alarming = /error|fail|could not|cannot|unable to|not found|not installed|fatal|exception|denied|no such file/i;
    for (const words of [keyringWords("this computer", true), keyringWords("this computer", false), keyringWords("this phone", false)]) {
      expect(words).not.toMatch(alarming);
    }
  });
});
