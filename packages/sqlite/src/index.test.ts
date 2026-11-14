import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the functions of the package", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "BrokenLogError",
      "EVENT_LOG_SCHEMA_VERSION",
      "SCHEMA_VERSIONS_TABLE",
      "SQLITE_FAULT_ACTIONS",
      "eventLog",
      "migrate",
      "openDatabase",
      "openEventLog",
      "schemaVersion",
      "sqliteFault",
      "transaction",
      "userVersion",
    ]);
  });
});
