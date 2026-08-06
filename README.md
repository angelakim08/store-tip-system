# YERSEN Tip Allocation System

Automates online tip allocation and payroll aggregation for a small retail dessert shop.

**Status:** Built and unit-tested. Pre-deployment — currently in setup, with shadow-mode validation scheduled before cutover.

---

## The problem

A retail dessert shop distributed online (card) tips through an entirely manual chain:

1. At close, staff read the tip total off the POS, split it by hand among whoever worked, and wrote the result on paper.
2. Every two weeks, the owner re-aggregated weeks of those paper slips per person and keyed the totals into payroll.

Two costs, and the second is bigger than the first. The per-shift arithmetic took a few minutes but was error-prone — especially with overlapping shifts, where one person's tips spanned two different crews. The payroll aggregation was slow, unauditable, and produced mistakes that only surfaced as wrong paychecks.

Interviews surfaced something that changed the design: **the pain staff reported (shift math) sat downstream of the actual bottleneck (payroll aggregation).** The system targets both, but the business case is the second.

---

## The approach

The key realization was that no human needs to enter a dollar amount at all.

> The POS already knows **how much** and **when**. The only thing it doesn't know is **who was working**.

So the system collects only that. Each person fills in a five-question form for their own shift — date, name, start, end, notes. No money, no math, and no reporting on anyone else.

Overlaps are then **derived rather than reported**. Every logged boundary across the day is pooled and sorted, and the day is cut at each one; between two adjacent boundaries the crew is constant. A coworker arriving five minutes before another falls out of the arithmetic instead of requiring someone to notice it — which matters in a workplace where start times flex.

This removed the single largest error source — a tired person doing arithmetic at 9pm — rather than automating around it.

```
Google Form (~15s per shift)              POS export
   who worked, from when to when          how much, when
            |                                   |
            v                                   v
     Form Responses tab                  Square Tips tab
              \                              /
               \_______  Apps Script  ______/
                  matched by timestamp
                          |
        +-----------------+------------------+
        v                 v                  v
   Daily Splits    Payroll Summary         Flags
   (audit trail)   (used on payday)   (needs a human)
```

---

## Why Apps Script and not Python

The builder is leaving for university. A Python script on a personal laptop would have died on departure, and a cloud deployment would have been unmaintainable by a non-technical owner.

Apps Script runs on Google's servers inside the shop's own Google account. Nobody needs a terminal, a laptop, or the original developer for it to keep working.

Python is used separately, for historical backfill analysis — recomputing past pay periods from POS exports to quantify pre-existing allocation error.

---

## Design decisions

**Integer cents, never floats.** `0.1 + 0.2 === 0.30000000000000004` in JavaScript. That belongs nowhere near payroll.

**Half-open shift windows `[start, end)`.** A tip at exactly a boundary goes to the incoming crew, so a handoff can never double-count.

**Individual logging over crew logging.** An earlier design had one person record the whole crew at each handoff. Switching to per-person in/out removed the coordination problem, eliminated the "who submits?" ambiguity, and aligned the incentive — forgetting to log now costs the person who forgot rather than a coworker.

**Deterministic penny allocation.** $47.00 split three ways is $15.6666. Truncating alone loses two cents and the payout stops reconciling. Leftover cents are allocated one per person, rotating by day-of-year so it evens out over time.

**Refuse, don't guess.** Tips falling outside every logged shift are flagged as unassigned, never absorbed into a neighbouring pool. A wrong number that looks confident is worse than no number, because nobody checks it.

**Stateless.** Every run recomputes from raw inputs. There is no accumulated total that can drift — fix the input, recalculate, and everything downstream is correct.

**No shift-count assumptions.** One shift or six, same code path. The shop runs a single evening shift in winter and up to three overlapping stretches in summer.

**Fails safe.** The system has no connection to the POS, payroll, or any bank. It reads a sheet and writes a sheet; its entire output is a number a human reads. Any confusing day can be done on paper without breaking anything.

---

## Validation

```bash
node test.js
```

24 unit tests covering penny reconciliation, derived overlaps from individually logged shifts, tips landing exactly on a boundary, multi-stretch days, unlogged shifts surfacing as unassigned money, duplicate-entry detection, uncovered gaps, voluntary share reductions, and input guardrails.

`splitLogic.js` holds the pure logic so it can be tested outside Google; `Code.gs` mirrors it. Change one, change both.

`TEST_PLAN.md` covers manual end-to-end testing in the live sheet, including five deliberate failure-mode tests.

---

## Files

| File | Purpose |
|---|---|
| `Code.gs` | Production script — runs in the shop's Google account |
| `splitLogic.js` | Pure allocation logic, unit-testable |
| `test.js` | Test suite |
| `BUILD_GUIDE.md` | Full spec, rules, and build sequence |
| `TEST_PLAN.md` | Manual end-to-end test cases |
| `OWNER_GUIDE.md` | Plain-language instructions for the shop |

---

## What I'd do differently

**Write the scope statement first.** The original design assumed staff were counting a physical cash jar, and the form had a field for typing a dollar amount. That was wrong — the tips in question were card tips already timestamped in the POS. Catching it meant rebuilding the data model, the form, and the test suite. A single paragraph defining what was in and out of scope, written on day one and shown to someone who knew the business, would have caught it in an hour.

**Locate columns by header, not position.** The first version read the form responses by column index. That broke immediately when email collection was switched on and shifted every column one to the right — silently, producing wrong numbers rather than an error. Matching on header text should have been the original design, not the fix. It's barely more code and it survives reordering, added questions, and renamed fields.

**The roster still lives in two places.** Staff names exist in both the form's checkbox list and the Config tab, and they have to be spelled identically in both — and match payroll. The system flags a mismatch rather than guessing, but it can't prevent one. This is the most likely thing to break after handoff. A single source of truth, with the form options generated from Config, would fix it properly.
---

## Note on data

All names in this repository are placeholders. Real staff names, transaction data, and configuration exist only in the shop's private spreadsheet and are never committed here.
