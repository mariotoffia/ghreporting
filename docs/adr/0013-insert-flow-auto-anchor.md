# 0013 — Insert-into-sheet uses auto-anchor placement (dialog deferred)

Status: accepted

## Context

T7.3 (IMPLEMENTATION_PLAN_DETAILS.md) describes the "insert into sheet" flow as an
explorer action opening a **dialog** — workbook picker (or "new"), sheet name, and
anchor cell (default `A1`) — before writing the dataset and creating the Binding.

Building that modal (form + validation + workbook/sheet enumeration + focus handling)
is UI whose correctness is only observable end-to-end (Playwright, T11.3). The
data-plane parts of the flow — query → matrix (header row first) → write → persist a
Binding → store — are pure/unit-testable and are the actual E7 deliverable
("a dataset lands in a sheet with headers").

A naive MVP that hardcodes `Sheet1!A1` for every insert is wrong: a second insert
overwrites the first and leaves two Bindings claiming the same cells (an adversarial QA
finding).

## Decision

Ship the insert flow **without a dialog** for now, with deterministic targets:

- Workbook: the currently active one in the Workbench (single-workbook UI today).
- Sheet: `Sheet1` (the default sheet of a fresh Univer workbook).
- Anchor: `nextAnchor(bindings, sheet)` — column A, one blank row below the lowest
  existing Binding on that sheet (or `A1` when empty). Repeated inserts **stack**
  instead of colliding.

The flow's logic (`insertIntoSheet`, `resultToMatrix`, `nextAnchor`) is dependency-
injected and unit-tested; the Univer write and the click-through are covered by the
e2e smoke test (T11.3).

## Consequences

- The E7 done-when holds and repeated inserts are safe (no clobber, no overlapping
  Bindings), with far less code than a modal.
- The user cannot yet choose a target workbook/sheet/anchor, and cannot insert into a
  second workbook. That is a deliberate gap, not an oversight.
- Upgrade path: add the picker/anchor dialog (its inputs feed the same
  `insertIntoSheet` params); nothing in the data plane changes.

## Rejected alternatives

- **Full dialog now:** correct but heavier UI, verifiable only via e2e; deferred, not
  cancelled.
- **Hardcode `Sheet1!A1`:** simplest, but silently corrupts on the second insert.
