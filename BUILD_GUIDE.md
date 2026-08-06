# YERSEN Online Tip System — Spec & Build Guide

**Status:** Week 1, pre-access
**Goal:** Allocate online tips to the right people automatically and hand the owner a payroll-ready total, in a system that keeps working after the builder leaves for school.

---

## 1. Scope

**In scope — online / card tips.** Customers add these at checkout. They land in Square with a timestamp. Today they are read off a screen, split by hand, written on paper, and re-added by the owner every two weeks for ADP.

**Out of scope — physical cash tips.** Split evenly by hand, informally, not run through payroll. Deliberately untouched. Not a technical decision and not the builder's call.

**Also out of scope — the delayed-paycheck issue.** That is ADP submission timing, not arithmetic. Fix = an SOP ("submit payroll by Thursday 5pm"), not software.

### Why the scope narrowing made this better
The original design had employees count and type a dollar figure at close. Scoping to online tips removes that entirely: **no human ever types a dollar amount.** Square already knows how much and when. The only thing a human contributes is *who was working*, which is the one fact Square does not have.

That deletes the largest error source in the system — a tired person doing arithmetic at 9pm — rather than automating around it.

---

## 2. The problem, stated properly

| | Who feels it | How often | Current cost |
|---|---|---|---|
| **A. Split arithmetic** | Employees | Every close | ~5 min of mental math, error-prone |
| **B. Payroll aggregation** | Owner | Every 2 weeks | Hand-summing weeks of paper per person, then keying into ADP |

B is the expensive one. A is the visible one. This solves both; B is the business case.

---

## 3. Rules (locked)

1. **Pooling** — tips pool per *stretch* and split evenly among whoever was present. A stretch is a window between two adjacent shift boundaries, derived from individually logged in/out times. Not hours-proportional.
2. **Matching** — each Square tip belongs to the stretch containing its timestamp. Windows are half-open `[start, end)`, so a tip at exactly 5:30 goes to the incoming crew and a handoff can never double-count.
3. **Rounding** — truncate to the cent; orphan pennies allocated one per person, rotating by day-of-year. Daily payout must reconcile to what Square collected.
4. **Missing data** — never assume. Tips with no matching stretch are flagged as unassigned, never absorbed into a neighbouring pool. Someone logging twice in a day is flagged, since they would otherwise count double.
5. **Owner** — in the pool only when working. May *reduce* his share; the freed amount redistributes so the total still reconciles. An override can never increase a share.
6. **Shift count is never assumed** — one person or six, same code path. No "shift 1" / "shift 2" anywhere. Overlaps are derived, not reported.

---

## 4. Architecture

```
Google Form  (~15 sec, once per stretch)          Square export
   who worked, from when to when                   how much, when
            |                                            |
            v                                            v
   Form Responses 1 tab                          Square Tips tab
            \                                          /
             \________________  Apps Script  _________/
                    matches tips to stretches by time
                                |
        +-----------------------+------------------------+
        v                       v                        v
   Daily Splits          Payroll Summary               Flags
   (audit trail)      (what the owner opens on payday)   (needs a human)
```

Lives in the **shop's** Google account. Runs on Google's servers. No laptop, no terminal, no Python in the live path.

**Python's role is separate and historical:** backfill past Square exports, recompute what tips should have been, compare to what was paid, quantify the error rate and time cost. That produces the baseline number. Analysis, not infrastructure.

---

## 5. Form fields

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | Business date | Date | Defaults to today |
| 2 | Your name | Dropdown | Roster — guarantees spelling matches Config |
| 3 | Your shift started at | Time | When *you* arrived |
| 4 | Your shift ended at | Time | When *you* left |
| 5 | Notes | Paragraph, optional | Anything unusual |

**No money field. No "who else worked" field. On purpose.**

Turn on **Settings → Collect email addresses** so every entry is traceable.

**Who fills it:** every person, once per shift, for themselves only. Nobody needs to know anyone else's hours.

### Why individual logging
Each person reports only their own in/out — the one thing they know exactly. All boundaries across the day are pooled and sorted, and the day is cut at every one. Between two adjacent boundaries the crew is constant, so that window is a stretch.

A five-minute overlap falls out of the arithmetic instead of needing someone to notice it:

| Logged | | |
|---|---|---|
| Employee A | 2:00 PM | 5:45 PM |
| Employee B | 5:40 PM | 9:00 PM |
| Employee C | 5:45 PM | 9:00 PM |

| Derived stretch | Crew |
|---|---|
| 2:00 – 5:40 | A |
| 5:40 – 5:45 | A, B |
| 5:45 – 9:00 | B, C |

Three properties this buys:
- **No coordination.** Nobody reports on anyone else.
- **No "who submits?" ambiguity.** Everyone submits for themselves.
- **Incentive alignment.** Forgetting to log costs *you* money, not a coworker.

### Time entry
Times use the native picker, not a dropdown. A 5-minute dropdown would be 145 options — unusable on a phone, and scrolling past your time is a more frequent error than the one it prevents.

AM/PM mistakes are caught instead by `EARLIEST_START`, `LATEST_END`, and `MAX_SHIFT_MINUTES` in Code.gs. Set these to the shop's real hours with about an hour of slack; the tighter they are, the more slips get caught. Anything that still gets through surfaces as unassigned tips.


---

## 6. Square Tips tab

Three columns, header row, pasted from the Square export:

| Date | Time | Tip |
|---|---|---|
| 2026-08-04 | 5:12 PM | 3.00 |

Zero and blank tips are ignored, which will be most rows. Extra columns to the right are ignored, so a wide export can be pasted without cleanup as long as these three land in A, B, C.

**Cadence:** paste before each payroll run. Twice a month, ~2 minutes.

---

## 7. Config tab

| Cell | Contents |
|---|---|
| B2 | Pay period type (semi-monthly: 1st–15th, 16th–EOM) |
| B3 | Alert email for flags |

Pay periods are semi-monthly (the 15th and the last day of the month), not biweekly. This is fixed in code, not configurable.

Then a roster table starting at **row 6**:

| | A — Name | B — Paid via |
|---|---|---|
| 6 | Employee A | ADP |
| 7 | Employee B | ADP |
| 8 | Employee C | Cash |

Names must be spelled **exactly as they appear in ADP**, and identically to the Form checkboxes.

### Why payout channel is here
Trainees are not on payroll and are handed their wage and online tips in cash at the end of each shift. Everyone else receives tips through ADP biweekly.

Payroll Summary labels the two differently and unambiguously:

- `ADP — enter in payroll` — the owner keys this into ADP
- `Cash — already paid nightly` — a record of money already handed over, **not** an instruction to pay
- `? — not in Config` — someone is missing from the roster table

**Trainee nightly payout is deliberately out of scope.** The sheet cannot know a shift's tips at close, because Square data only arrives when the export is pasted twice a month. Trainees keep being paid the way they are today: read the total off the terminal, split, hand over cash. That process is same-day and not broken, so it is left alone.

**Trainees must still be logged in the form anyway.** Their share comes out of the same pool, so omitting them inflates everyone else's split. They are logged for other people's numbers to be right, not for their own payout.

Classification is the owner's decision — record what he says, don't infer it.

Anyone appearing in the shift log but missing from this table shows as `?` in Payroll Summary and raises a flag, rather than being silently assumed to be on payroll.

---

## 8. Wages are deliberately absent

Hourly rates are not collected, stored, or referenced anywhere. This system computes **tip dollars per person**; ADP already computes hourly pay from hours. The two are added inside ADP at payroll time and neither needs to know the other exists.

Excluding wages also keeps individual pay rates out of a spreadsheet that several employees can see.

---

## 9. Online orders

Online cake and gelato orders are timestamped when the **order is placed**, not when it's picked up — cakes are collected two or more days later. Confirmed that tips are not currently accepted on online orders, so these appear as transactions with no tip and are skipped entirely.

If online tipping is ever turned on, those tips will land as *unassigned* and be flagged rather than paid to whoever happened to be working when the order was placed. That's the correct default — an order placed at 3am for Thursday pickup has no obvious owner — but it becomes a policy question someone has to answer.

**Still to confirm:** whether the tip export comes from Square or Squarespace. Both are in use; only one holds the file the owner needs to pull.

---

## 10. Week 1 checklist

**From the owner**
- [ ] Square export with tips + timestamps, one recent month (CSV) — **confirm the export actually contains a time column, not just a date**
- [ ] Screenshot or description of the ADP tip-entry screen — **not login access**
- [ ] Permission to create the Form + Sheet in the shop's Google account
- [ ] Roster spelling as it appears in ADP
- [ ] Who is on payroll vs. paid in cash (ask the owner, do not infer)

**From yourself — cannot be recovered later**
- [ ] Stopwatch three closes. Record minutes spent on tip math.
- [ ] Ask the owner how long payroll prep takes, and whether tip errors have needed correcting
- [ ] Confirm: are online tips visible per-transaction, or only as a daily total?

**Build**
- [ ] Create Form per §5
- [ ] Link to a Sheet; add `Square Tips` and `Config` tabs
- [ ] Extensions → Apps Script, paste `Code.gs`, Save
- [ ] Run `setupTriggers`, approve permissions
- [ ] Paste one week of real Square tips, submit matching shift entries, check Daily Splits
- [ ] Break it on purpose: skip a stretch, log overlapping times, leave the roster unchecked. All three must appear in Flags.

---

## 11. Week 2 — Shadow mode

The new system runs alongside paper. Nothing depends on it. Nobody is paid from it.

- [ ] Announce it to the team: "we're testing this, keep doing paper exactly as normal"
- [ ] Add **"submit shift form"** to the end-of-day checklist
- [ ] Walk each closer through the form once, in person, on their own phone
- [ ] Paste the running Square export into `Square Tips` mid-week
- [ ] Check `Flags` every single day — this is the week flags are most useful
- [ ] Keep a running log: date, what broke, what you changed

**Do not skip the announcement.** If people discover a new form on the checklist without context, compliance drops.

---

## 12. Week 3 — Verify

- [ ] Every day: compare the sheet's split against the paper split
- [ ] Log every mismatch with its cause — a bug, or a rule nobody had written down
- [ ] Fix bugs. Add newly discovered rules to §3 of this document
- [ ] Confirm at least one full week matches paper exactly, with zero unexplained flags
- [ ] Run the Python backfill on historical Square exports
- [ ] Record the baseline comparison: hand-calculated vs. recomputed, and the error count

**Target before proceeding:** seven consecutive days matching paper. If week 3 ends without that, extend shadow mode into week 4 and ship a smaller thing. A system that runs one week longer in shadow is fine. A system handed over unverified is not.

---

## 13. Week 4 — Handoff

- [ ] Write the one-page instruction sheet (see §14) and print it
- [ ] Sit with the owner while **he** pastes a Square export and reads Payroll Summary — do not do it for him
- [ ] Walk him through `Config`: adding a new hire, changing ADP vs. Cash
- [ ] Show him `Flags` and the fallback: any confusing day gets done on paper
- [ ] Confirm every closer has submitted unsupervised at least twice
- [ ] Transfer Sheet and Form ownership to the owner's account
- [ ] Agree on one check-in date in October
- [ ] Push the final repo, write the README

Shadow mode is where the resume number comes from. It cannot be reconstructed later.

---

## 14. When something goes wrong

The system is a layer on top of the existing process, not a replacement for it. Nothing it does is irreversible.

| Symptom | What it means | Fix |
|---|---|---|
| Flag: tips outside every shift | A stretch wasn't logged, or times are wrong | Add the missing form entry, hit Recalculate |
| Flag: stretches overlap | Two people logged the same minutes | Fix one entry's times, Recalculate |
| Flag: name not on roster | New hire, or a spelling mismatch | Add to `Config` rows 6+, Recalculate |
| Flag: no shift logged | Nobody filled the form that day | Add it late, or do that day on paper |
| Numbers look wrong | Bad input, or a bug | Do that day on paper. Investigate later. |
| Everything is confusing | — | Do the whole pay period on paper. Nothing is lost. |

**Three properties that make this safe:**

1. **Read-only.** No connection to Square, Squarespace, ADP, or any bank. It reads a sheet and writes a sheet. Output is a number the owner reads, never an action taken.
2. **Stateless.** Every run recomputes from scratch off raw form responses and pasted tips. No running total can drift. Fix the input, hit Recalculate, everything downstream is correct.
3. **Day-independent.** A broken Tuesday doesn't touch Wednesday. Bad days get done on paper individually.

**The abort procedure:** stop filling in the form. That's it. Everyone returns to exactly what they do today. Nothing was deleted, no process was dismantled.

### The one-page sheet for the shop
Written in plain language, printed, kept by the register:
1. What the form is and when to fill it (with a QR code to it)
2. Who submits when two people leave together
3. That there is no math and no money to enter
4. Who to text if something looks wrong
5. **If in doubt, do it on paper. Nothing breaks.**

---

## 15. Handoff requirements

- [ ] the owner can open Payroll Summary and read it unaided
- [ ] the owner has pasted the Square export himself at least once
- [ ] Every closer has submitted the form unsupervised at least twice
- [ ] One page of written instructions exists, physically, at the shop
- [ ] the owner knows: **if it ever breaks, go back to paper.** Nothing is lost.
- [ ] the owner owns the Sheet. Employee A is a collaborator, removable.

### Known maintenance point
The roster is a manual list in two places — the Form checkboxes and the `Config` roster table (rows 6+). A new hire must be added to both, spelled identically, matching ADP. This is the most likely thing to break after handoff. It belongs in the written instructions.

---

## 16. Testing

`splitLogic.js` holds the pure allocation logic; `Code.gs` mirrors it. `test.js` covers 16 cases: penny reconciliation, the 2–9 / 5:30 overlap, tips landing exactly on a handoff, three-stretch summer days, single-stretch school days, unlogged stretches surfacing as unassigned money, overlapping stretches, owner overrides, and both guardrails.

```
node test.js
```

Change one copy of the logic, change both, re-run.
