import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("exports the functions of the package", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "BrokenLogError",
      "EVENT_LOG_SCHEMA_VERSION",
      "IntegrityError",
      "SCHEMA_VERSIONS_TABLE",
      "SQLITE_FAULT_ACTIONS",
      "SchemaError",
      "addMissingColumns",
      "checkIntegrity",
      "ensureProjection",
      "eventLog",
      "migrate",
      "openDatabase",
      "openEventLog",
      "openOrQuarantine",
      "quarantine",
      "readTransaction",
      "salvageEventLog",
      "schemaVersion",
      "snapshot",
      "sqliteFault",
      "tableColumns",
      "transaction",
      "userVersion",
      "wasmConnection",
    ]);
  });
});
