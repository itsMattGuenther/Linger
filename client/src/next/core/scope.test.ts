import { describe, expect, it } from "vitest";
import { EVERY_SERVER, inScope, scopeOptions, startScope } from "./scope";

const home = { server: "https://good-company.example", name: "The Good Company", accent: "amber" };
const guild = { server: "https://ashen-lanterns.example", name: "Ashen Lanterns", accent: "violet" };
const lisbon = { server: "https://casa-da-ribeira.example", name: "Casa da Ribeira", accent: null };

describe("which servers a view looks through", () => {
  it("starts on the only server there is, whatever it was opened from", () => {
    expect(startScope([home])).toBe(home.server);
    expect(startScope([home], guild.server)).toBe(home.server);
  });

  it("starts on the server it was opened from, or on every server", () => {
    expect(startScope([home, guild, lisbon], guild.server)).toBe(guild.server);
    expect(startScope([home, guild, lisbon])).toBe(EVERY_SERVER);
    expect(startScope([home, guild], lisbon.server)).toBe(EVERY_SERVER);
  });

  it("offers every server first, then each by name in the list's order", () => {
    expect(scopeOptions([guild, home])).toEqual([
      { value: EVERY_SERVER, label: "Every server" },
      { value: guild.server, label: "Ashen Lanterns" },
      { value: home.server, label: "The Good Company" },
    ]);
  });

  it("covers one server, or all of them for every server or one that's gone", () => {
    expect(inScope(guild.server, [home, guild, lisbon])).toEqual([guild]);
    expect(inScope(EVERY_SERVER, [home, guild, lisbon])).toEqual([home, guild, lisbon]);
    expect(inScope("https://gone.example", [home, guild])).toEqual([home, guild]);
  });
});
