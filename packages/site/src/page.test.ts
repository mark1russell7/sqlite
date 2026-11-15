import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("the home page", () => {
  it("names the package and gives the install command", () => {
    expect(page).toContain("<title>sqlite</title>");
    expect(page).toContain("pnpm add @mark1russell7/sqlite");
  });

  it("links to the pages of site-pages and to the repository", () => {
    expect(page).toContain('href="./releases/"');
    expect(page).toContain('href="./status/"');
    expect(page).toContain('href="https://github.com/mark1russell7/sqlite"');
  });

  it("has the demo of the event log, and says that the package is on npm", () => {
    for (const id of ["demo", "engine", "agreement", "copies", "exchange", "reset", "last", "conflicts", "laws"]) expect(page).toContain(`id="${id}"`);
    expect(page).toContain("Each version is on npm.");
    expect(page).not.toContain("no release on npm yet");
  });
});
