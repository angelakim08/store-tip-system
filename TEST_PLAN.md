# Test Plan — YERSEN Tip Tracker

Work top to bottom. Tick each box. Log anything that doesn't match.

**All test dates are in 2020** so every fake row is obvious and easy to delete later. Never use a real date for testing.

## Before you start

Config must contain exactly this roster:

| A | B |
|---|---|
| Employee A | ADP |
| Employee B | ADP |
| Employee C | Cash |

All three must also appear in the Form's checkbox list, spelled identically.

After each test: **Tips → Recalculate now**, then check the tabs.

---

## Group A — Does the math work?

### A1. One shift, two people
**Form:** `2020-01-01` · 5:30 PM → 9:00 PM · Employee A, Employee B
**Square Tips:**
| 2020-01-01 | 6:00 PM | 20.00 |
| 2020-01-01 | 8:00 PM | 40.00 |

- [ ] Daily Splits: Employee A **30.00**, Employee B **30.00**
- [ ] Flags: nothing for this date

---

### A2. Handoff mid-shift
**Form (two entries):**
- `2020-01-02` · 2:00 PM → 5:30 PM · Employee A
- `2020-01-02` · 5:30 PM → 9:00 PM · Employee A, Employee B

**Square Tips:**
| 2020-01-02 | 3:00 PM | 30.00 |
| 2020-01-02 | 7:00 PM | 50.00 |

- [ ] Employee A **55.00** (30 alone + half of 50)
- [ ] Employee B **25.00**
- [ ] No flags

*This is the case that was hardest to do on paper. If it's right, the core works.*

---

### A3. Three stretches (summer pattern)
**Form (three entries):**
- `2020-01-03` · 11:00 AM → 2:00 PM · Employee C
- `2020-01-03` · 2:00 PM → 5:00 PM · Employee A
- `2020-01-03` · 5:00 PM → 9:00 PM · Employee A, Employee B

**Square Tips:**
| 2020-01-03 | 12:00 PM | 20.00 |
| 2020-01-03 | 3:00 PM | 30.00 |
| 2020-01-03 | 7:00 PM | 40.00 |

- [ ] Employee C **20.00**
- [ ] Employee A **50.00**
- [ ] Employee B **20.00**
- [ ] No flags

---

### A4. Tip landing exactly on a handoff
**Form:**
- `2020-01-04` · 2:00 PM → 5:30 PM · Employee A
- `2020-01-04` · 5:30 PM → 9:00 PM · Employee A, Employee B

**Square Tips:**
| 2020-01-04 | 5:30 PM | 10.00 |

- [ ] Employee A **5.00**, Employee B **5.00** — the incoming crew shares it
- [ ] Employee A does **not** get all 10.00

---

### A5. Rounding — the pennies must reconcile
**Form:** `2020-01-05` · 5:00 PM → 9:00 PM · Employee A, Employee B, Employee C
**Square Tips:**
| 2020-01-05 | 6:00 PM | 47.00 |

- [ ] Three amounts, two at **15.67** and one at **15.66** (any order)
- [ ] They add to exactly **47.00** — check with a calculator
- [ ] Not 15.66 three times (that would lose 2 cents)

---

## Group B — Does it catch mistakes?

*These are the important ones. A system that only works when everything is perfect is not safe to hand over.*

### B1. Somebody forgot to fill in the form
**Form:** `2020-01-06` · 5:00 PM → 9:00 PM · Employee A *(only this one)*
**Square Tips:**
| 2020-01-06 | 12:00 PM | 25.00 |
| 2020-01-06 | 6:00 PM | 10.00 |

- [ ] Flags shows **"Tips outside every shift"** mentioning **$25.00**
- [ ] Employee A gets **10.00** only — the 25.00 is **not** given to her

*The second box matters more than the first. Silently absorbing that 25.00 would be the worst bug in the system.*

---

### B2. Overlapping shifts
**Form:**
- `2020-01-07` · 2:00 PM → 6:00 PM · Employee A
- `2020-01-07` · 5:00 PM → 9:00 PM · Employee B

**Square Tips:**
| 2020-01-07 | 7:00 PM | 20.00 |

- [ ] Flags shows **"Stretches overlap"**

---

### B3. Tips but nobody logged anything
**Form:** nothing at all for this date
**Square Tips:**
| 2020-01-08 | 6:00 PM | 35.00 |

- [ ] Flags shows **"No shift logged"** mentioning **$35.00**
- [ ] Nobody is paid for this date

---

### B4. A name that isn't on the roster
In the **Form_Responses** tab, find your A1 row. In the "Who worked" cell, type `, TestPerson` at the end. Recalculate.

- [ ] Flags shows **"Name not on the roster"** for TestPerson
- [ ] Payroll Summary shows TestPerson as **`? — not in Config`**
- [ ] TestPerson is **not** labelled ADP

Then remove `, TestPerson` and Recalculate. Flag should disappear.

---

### B5. Nobody checked at all
In **Form_Responses**, clear the "Who worked" cell on your A1 row. Recalculate.

- [ ] Flags shows **"Nobody listed"**
- [ ] No payment is invented for that day

Put the names back and Recalculate.

---

## Group C — Does the setup work?

### C1. The trigger fires by itself
Submit a new form entry. **Do not click Recalculate.** Wait about 30 seconds and reload the sheet.

- [ ] Daily Splits updated on its own

*If this fails, the triggers weren't installed. Nothing runs after you leave without this.*

---

### C2. Running it twice changes nothing
Click **Recalculate now** twice in a row.

- [ ] Every number is identical both times
- [ ] No duplicated rows

---

### C3. Labels are right
Look at Payroll Summary.

- [ ] Employee A and Employee B: `ADP — enter in payroll`
- [ ] Employee C: `Cash — already paid nightly`
- [ ] Newest pay period is at the **top**

---

### C4. Reminder email
In the Apps Script editor, choose `nightlyCheck` from the dropdown and click Run. (Today has no shift logged, so it should fire.)

- [ ] Email arrives at the address in Config B3

---

## Cleaning up

The system stores no hidden state — it rebuilds everything from the two input tabs each run. So deleting the inputs deletes everything.

**Step 1 — Form_Responses tab**
Select every 2020 row. Right-click → **Delete rows**.
⚠️ Do **not** delete row 1 (the headers).

**Step 2 — Square Tips tab**
Same thing. Delete every 2020 row. Keep row 1.

**Step 3 — Recalculate**
Tips → Recalculate now.

**Step 4 — Confirm it's clean**
- [ ] Daily Splits: only the header row
- [ ] Payroll Summary: only the header row
- [ ] Flags: only the header row

**Step 5 — Clear the Form's own copy (optional)**
The Form keeps its own record separately from the sheet. It doesn't affect any calculation, but to tidy it: open the Form → Responses → three dots → **Delete all responses**.

**Do not** delete the Config tab or any tab itself. Only rows.

---

## Log your results

Keep this — it's evidence for week 3 and it's what you'll talk about in interviews.

| Test | Pass? | What went wrong | Fix |
|---|---|---|---|
| A1 | | | |
| A2 | | | |
| A3 | | | |
| A4 | | | |
| A5 | | | |
| B1 | | | |
| B2 | | | |
| B3 | | | |
| B4 | | | |
| B5 | | | |
| C1 | | | |
| C2 | | | |
| C3 | | | |
| C4 | | | |

**Do not move to shadow mode until every box in Group B passes.** Group A failing is a visible wrong number someone will catch. Group B failing is a wrong number that looks completely normal.
