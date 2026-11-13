import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the functions of the package", () => {
    expect(Object.keys(entry).sort()).toEqual(["EVENT_LOG_SCHEMA_VERSION", "migrate", "openDatabase", "openEventLog", "transaction", "userVersion"]);
  });
});
