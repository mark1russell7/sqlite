import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSqliteWarning, quietSqliteWarning, SQLITE_WARNING, type WarningTarget } from "./warning.ts";

const NODE_TEXT = "SQLite is an experimental feature and might change at any time";

class ExperimentalWarning extends Error {
  override readonly name = "ExperimentalWarning";
}

describe("isSqliteWarning", () => {
  it("finds the warning by each form of the type", () => {
    expect(isSqliteWarning(NODE_TEXT, "ExperimentalWarning")).toBe(true);
    expect(isSqliteWarning(NODE_TEXT, { type: "ExperimentalWarning" })).toBe(true);
    expect(isSqliteWarning(new ExperimentalWarning(NODE_TEXT))).toBe(true);
  });

  it("keeps a different text or a different type", () => {
    expect(isSqliteWarning("Fetch is an experimental feature", "ExperimentalWarning")).toBe(false);
    expect(isSqliteWarning(NODE_TEXT, "DeprecationWarning")).toBe(false);
    expect(isSqliteWarning(NODE_TEXT)).toBe(false);
    expect(isSqliteWarning(new Error(NODE_TEXT))).toBe(false);
  });
});

describe("quietSqliteWarning", () => {
  it("removes only the warning of node:sqlite, and puts the earlier function back", () => {
    const seen: unknown[][] = [];
    const target: WarningTarget = {
      emitWarning(...args: unknown[]) {
        seen.push(args);
      },
    };
    const earlier = target.emitWarning;
    const restore = quietSqliteWarning(target);
    target.emitWarning(NODE_TEXT, "ExperimentalWarning");
    target.emitWarning("OTHER", "ExperimentalWarning");
    expect(seen).toEqual([["OTHER", "ExperimentalWarning"]]);
    restore();
    expect(target.emitWarning).toBe(earlier);
    target.emitWarning(NODE_TEXT, "ExperimentalWarning");
    expect(seen).toHaveLength(2);
  });

  it("does not put back a function that a later filter replaced", () => {
    const target: WarningTarget = { emitWarning: () => undefined };
    const restore = quietSqliteWarning(target);
    const later = (): void => undefined;
    target.emitWarning = later;
    restore();
    expect(target.emitWarning).toBe(later);
  });

  it("works on process by default", async () => {
    const seen: string[] = [];
    const listener = (warning: Error): void => {
      seen.push(warning.message);
    };
    process.on("warning", listener);
    const restore = quietSqliteWarning();
    try {
      process.emitWarning(NODE_TEXT, "ExperimentalWarning");
      process.emitWarning("OTHER-WARNING", "TestWarning");
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      restore();
      process.off("warning", listener);
    }
    expect(seen).toEqual(["OTHER-WARNING"]);
  });

  it("is in a file that does not import node:sqlite", () => {
    const source = readFileSync(new URL("./warning.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import /m);
    expect(NODE_TEXT.startsWith(SQLITE_WARNING)).toBe(true);
  });
});
