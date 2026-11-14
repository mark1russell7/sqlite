# Roadmap

This file is the plan of sqlite. The Status page of the site reads it, and the tracker of the project mirrors it.

| ID | Item | Status | Summary |
| --- | --- | --- | --- |
| SQ-1 | The first package | done | Version 0.1.0: the pragmas, the migrations by `user_version`, `BEGIN IMMEDIATE` transactions, the event log and the filter of the warning. |
| SQ-2 | A schema version for each part of a file | done | A library and the app keep their tables in one file, and each part has its own version. |
| SQ-3 | The event log as a grow-only set | done | A duplicate changes nothing, a conflict is reported, and the log has reads after a position and by type. |
| SQ-4 | The fault kind of each error | done | The kind of each error of `node:sqlite` and the action that it needs, from the result code. |
| SQ-5 | Release 0.2.0 | done | Release SQ-2, SQ-3 and SQ-4, and give the API to the first user. |
| SQ-6 | Recovery of a broken file | done | Version 0.2.1: an integrity check, the quarantine of a file with its WAL and SHM files, the salvage of a log and an online backup. |
| SQ-7 | Nested transactions | done | Version 0.2.2: savepoints in a transaction, so a work can call a different work that writes. The event log can join a transaction of the caller. |
| SQ-8 | The file of an older app | done | Version 0.2.3: adopt a file that has tables but no schema version. |
| SQ-9 | The first move | open | An app with its own event log moves to this package. |
| SQ-10 | The second move | open | An app with four stores moves to this package. |
| SQ-11 | The third move | open | An app with its own store and migrations moves to this package. |
| SQ-12 | The map of homes | done | The map of homes tells that the package is on npm. |
| SQ-13 | The site | open | A live demo of the event log and the faults. |
| SQ-14 | Standard Schema validators | open | A validator of the Standard Schema as the parse of a log. |
| SQ-15 | Projections | open | A file of a projection or a cache opens empty when its version differs, as the index and the vectors of polite-crawler do today. SQ-10 needs it. |
