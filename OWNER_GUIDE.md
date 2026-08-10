# Owner Guide — Tip Tracker

*Written for a non-technical owner. Short sentences, no jargon. Print double-sided and keep it near the register.*

---

## What the computer does

- It looks at the tips already recorded in the payment system.
- It sees who was working at that time.
- It divides the tips between them.
- It adds up the total for each person for the pay period.

## What the computer CANNOT do

- It **cannot** move money.
- It **cannot** open payroll.
- It **cannot** touch a bank account.
- It **cannot** change anything in the payment system.

It only shows numbers on a screen. **You** decide what to do with them.

---

## Every day

**You do nothing.**

Each person fills in a short form when their own shift ends — their name, and the times they started and finished. Nothing else.

The computer works out who was working together at each moment and divides the tips by itself, right away.

Nobody needs to click anything.

---

## Payday — 5 steps

### 1. Download the tips
Open Square. Download the transactions for this pay period.

### 2. Put them in the sheet
Click the tab at the bottom called **Square Tips**.

Paste **under the last row**. Do not delete the old rows.

The first three columns must be:

| Date | Time | Tip |
|---|---|---|
| 2026-08-04 | 5:12 PM | 3.00 |

### 3. Click one button
At the top, click **Tips**, then **Recalculate now**. Wait 5 seconds.

### 4. Check the Flags tab

**Empty?** Good, go to step 5.
**Something written in it?** Read it, then see Problems below.

### 5. Open the Payroll Summary tab

The newest period is at the **top**.

| If it says | Do this |
|---|---|
| **ADP — enter in payroll** | Put this amount in payroll as tips |
| **Not in payroll — owner settles directly** | **Nothing.** You handle this person yourself. Record only. |
| **? — not in Config** | Stop. See Problems below. |

**Never enter a "Not in payroll" line into ADP.** You settle that person directly. The row is only so the amount is written down.

---

## Remember

**If anything is confusing, do it on paper the old way.**

Nothing breaks. Nothing is lost. You can stop using this at any time.

---

## Problems

| Message | Meaning | What to do |
|---|---|---|
| **Tips outside every shift** | Someone forgot the form | Ask who worked. Add the missing entry. Recalculate |
| **No shift logged** | Nobody filled the form that day | Add it now, or do that day on paper |
| **No name on the entry** | The name was left blank | Ask whose shift it was. Fix it. Recalculate |
| **Logged twice** | One person submitted twice that day | Fine if they worked two separate periods. Otherwise delete the extra row |
| **Shift looks too long** | Probably an AM/PM mistake | Check the end time. Fix it. Recalculate |
| **Start time looks wrong** | Probably an AM/PM mistake | Check the start time. Fix it. Recalculate |
| **Name not on the roster** | New person, or spelled differently | Add them to **Config**. Recalculate |

**Still wrong?** Do that day on paper, then contact the administrator.
**Everything wrong?** Do the whole pay period on paper. Nothing is lost.

---

## Adding a new person

Two places. Spelled **exactly the same** in both, and the same as payroll.

**1. The form** — find "Your name" and add them to the list.

**2. The Config tab** — name in column A, then in column B choose:

- **ADP** — goes into payroll like everyone else
- **Cash** — not on payroll; you pay this person yourself

The question column B is really asking is: *does this person go into ADP?*

## When someone starts going through payroll

In **Config**, change **Cash** to **ADP**.

Do this on the **first day of a new pay period**, not in the middle.

## When someone leaves

Remove their name from the **form**.
**Leave their name in Config.** The old records need it.

---

## Things to know

- Nothing is ever deleted. Old pay periods stay in the sheet.
- Made a mistake? Fix it and click **Recalculate now**. Everything corrects itself.
- One bad day does not affect any other day.
- The system emails a reminder if nobody fills the form by 10pm.

---

## Tabs

| Tab | What it is |
|---|---|
| Form Responses | What staff filled in. Do not type here unless fixing a mistake |
| Square Tips | Where you paste the export |
| Config | Roster, email, pay period date |
| Daily Splits | Each person's tips, day by day |
| **Payroll Summary** | **The one you use on payday** |
| Flags | Problems to look at |
