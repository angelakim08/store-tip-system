/**
 * YERSEN Gelato Cakes — online tip allocation and payroll summary.
 *
 * SCOPE
 *   Online / card tips collected through Square only.
 *   Physical cash tips are split evenly by hand and are NOT handled here.
 *
 * HOW IT WORKS
 *   Square knows how much and when. The shift log knows who.
 *   This joins them by timestamp. No human ever types a dollar amount.
 *
 * TABS
 *   Form Responses 1   shift log, written by the Google Form — never hand-edit
 *   Square Tips        pasted from the Square export: Date | Time | Tip
 *   Config             roster, pay period anchor, alert email, owner's own shifts
 *   Daily Splits       generated
 *   Payroll Summary    generated — what the owner opens on payday
 *   Flags              generated — anything needing a human
 *
 * SETUP
 *   Extensions > Apps Script, paste this in, Save, run `setupTriggers` once.
 */

var SETTINGS = {
  ROTATE_PENNIES: true,
  NIGHTLY_CHECK_HOUR: 22,
  EARLIEST_START: 10 * 60,
  LATEST_END: 22 * 60,
  MAX_SHIFT_MINUTES: 12 * 60,
  CLOSED_DAYS: [1],
  TZ: 'America/Los_Angeles'
};

var TAB = {
  RESPONSES: 'Form Responses 1',
  TIPS: 'Square Tips',
  CONFIG: 'Config',
  DAILY: 'Daily Splits',
  PAYROLL: 'Payroll Summary',
  FLAGS: 'Flags'
};

// ---------------------------------------------------------------------------
// Parsing. Money is integer cents everywhere — never floats.
// ---------------------------------------------------------------------------
function toCents(value) {
  if (value === '' || value === null || value === undefined) return null;
  var n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[$,\s]/g, ''));
  if (isNaN(n)) return null;
  return Math.round(n * 100);
}

function toDollars(cents) { return cents / 100; }

/**
 * Minutes past midnight. Google returns Dates sometimes and strings others,
 * and the strings arrive as '5:30:00 PM' — with seconds between the time and
 * the AM/PM. Look for the suffix anywhere in the string, not just adjacent.
 */
function parseMinutes(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (value instanceof Date) return value.getHours() * 60 + value.getMinutes();

  var s = String(value);
  var t = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!t) return null;

  var h = parseInt(t[1], 10);
  var min = parseInt(t[2], 10);

  var suffix = s.match(/([ap])\.?\s*m/i);
  if (suffix) {
    var isPm = suffix[1].toLowerCase() === 'p';
    if (isPm && h < 12) h += 12;
    if (!isPm && h === 12) h = 0;
  }

  return h * 60 + min;
}

function dayKey(date) {
  return Utilities.formatDate(date, SETTINGS.TZ, 'yyyy-MM-dd');
}

/**
 * Turn whatever the sheet gives us into 'yyyy-MM-dd'.
 *
 * Accepts a real Date, '1/1/2020', '01/01/2020', or '2020-01-01' so the form
 * and the pasted export can disagree about format without breaking the match.
 *
 * Deliberately does NOT convert through a timezone. A Date from a sheet is
 * already midnight in the sheet's own timezone; running it through
 * Utilities.formatDate with a different zone rolls it back a day, which turns
 * every date silently into the one before it.
 */
function normalizeDate(value) {
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  if (value instanceof Date) {
    return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
  }

  var s = String(value).trim();
  if (!s) return '';

  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return iso[1] + '-' + pad(parseInt(iso[2], 10)) + '-' + pad(parseInt(iso[3], 10));

  var us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return us[3] + '-' + pad(parseInt(us[1], 10)) + '-' + pad(parseInt(us[2], 10));

  return s;
}

function dayOfYear(dateStr) {
  var d = new Date(dateStr + 'T12:00:00');
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** '2026-08-04' -> 'Aug 4, 2026'. Nobody reads ISO dates at 11pm. */
function friendlyDate(iso) {
  var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return MONTHS[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10) + ', ' + m[1];
}

/** '2026-08-01 to 2026-08-15' -> 'Aug 1 - 15, 2026'. */
function friendlyPeriod(label) {
  var m = String(label).match(/^(\d{4})-(\d{2})-(\d{2}) to (\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return label;
  return MONTHS[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10) +
         ' - ' + parseInt(m[6], 10) + ', ' + m[1];
}

function minutesToClock(m) {
  var h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 === 0 ? 12 : h % 12) + ':' + (mm < 10 ? '0' : '') + mm + (h < 12 ? 'am' : 'pm');
}

/**
 * Where a flag should say a bad entry lives, given which sheet it came from.
 * Staff shifts point back to Form Responses; the owner's own shifts point
 * back to Config. Getting this wrong is confusing in a very specific way —
 * it sends someone looking for a row number in the wrong tab entirely.
 */
function sourceLabel(source, row) {
  if (source === 'config') return 'Config, row ' + row + ' (the owner\'s own shift table)';
  return 'row ' + row + ' of the form responses';
}

// ---------------------------------------------------------------------------
// Allocation. Mirrors splitLogic.js, which carries the unit tests.
// Change one, change both, re-run `node test.js`.
// ---------------------------------------------------------------------------
function splitPool(poolCents, people, rotation) {
  if (!people || people.length === 0) throw new Error('Stretch with nobody logged.');
  if (poolCents < 0) throw new Error('Negative pool: ' + poolCents);

  var n = people.length;
  var base = Math.floor(poolCents / n);
  var leftover = poolCents - base * n;
  var ordered = people.slice().sort();

  var out = {};
  for (var i = 0; i < n; i++) out[ordered[i]] = base;
  for (var k = 0; k < leftover; k++) out[ordered[(rotation + k) % n]] += 1;
  return out;
}

/** Half-open windows: a tip at exactly 5:30 belongs to the incoming crew. */
function assignTips(stretches, tips) {
  var sorted = stretches.slice().sort(function (a, b) { return a.startMinutes - b.startMinutes; });

  var pools = sorted.map(function (s) {
    return { startMinutes: s.startMinutes, endMinutes: s.endMinutes, people: s.people, cents: 0 };
  });

  var unassigned = [];
  tips.forEach(function (tip) {
    var placed = false;
    for (var i = 0; i < pools.length; i++) {
      if (tip.minutes >= pools[i].startMinutes && tip.minutes < pools[i].endMinutes) {
        pools[i].cents += tip.cents;
        placed = true;
        break;
      }
    }
    if (!placed) unassigned.push(tip);
  });

  return { pools: pools, unassigned: unassigned };
}

/**
 * Turn individually logged shifts into the stretches tips get split across.
 *
 * Each person reports only their own in/out. All boundaries are pooled and
 * sorted, and the day is cut at every one. Between two adjacent boundaries
 * the crew is constant, so that window is a stretch.
 *
 * This is why nobody needs to know anyone else's hours — a five-minute
 * overlap falls out of the arithmetic instead of needing to be noticed.
 */
function buildStretches(shifts) {
  if (!shifts || !shifts.length) return [];

  var points = [];
  shifts.forEach(function (s) {
    if (points.indexOf(s.startMinutes) === -1) points.push(s.startMinutes);
    if (points.indexOf(s.endMinutes) === -1) points.push(s.endMinutes);
  });
  points.sort(function (a, b) { return a - b; });

  var stretches = [];
  for (var i = 0; i < points.length - 1; i++) {
    var from = points[i], to = points[i + 1];
    var people = [];
    shifts.forEach(function (s) {
      if (s.startMinutes <= from && s.endMinutes >= to && people.indexOf(s.person) === -1) {
        people.push(s.person);
      }
    });
    if (people.length) stretches.push({ startMinutes: from, endMinutes: to, people: people });
  }
  return stretches;
}

/** Someone logging twice in a day would count double in every window. */
function findDuplicatePeople(shifts) {
  var seen = {}, dupes = [];
  shifts.forEach(function (s) {
    if (seen[s.person] && dupes.indexOf(s.person) === -1) dupes.push(s.person);
    seen[s.person] = true;
  });
  return dupes;
}

/**
 * Apply a voluntary reduction (the owner taking less than his computed
 * share). The freed amount is redistributed across everyone else in that
 * day's totals so the day still reconciles to what Square collected.
 * Mirrors splitLogic.js — keep both in sync.
 */
function applyOverrides(totals, overrides, rotation) {
  if (!overrides || Object.keys(overrides).length === 0) return totals;

  var result = {};
  for (var k in totals) result[k] = totals[k];

  var freed = 0, recipients = [];
  for (var name in result) {
    if (overrides.hasOwnProperty(name)) {
      if (overrides[name] > result[name]) {
        throw new Error(name + ': an override can only lower a share, never raise it.');
      }
      freed += result[name] - overrides[name];
      result[name] = overrides[name];
    } else {
      recipients.push(name);
    }
  }

  if (freed > 0) {
    if (recipients.length === 0) throw new Error('Everyone overrode — freed money has nowhere to go.');
    var extra = splitPool(freed, recipients, rotation);
    for (var r in extra) result[r] += extra[r];
  }
  return result;
}

function computeDay(shifts, tips, rotation) {
  var stretches = buildStretches(shifts);
  var assigned = assignTips(stretches, tips);
  var totals = {};
  assigned.pools.forEach(function (pool) {
    if (pool.cents === 0) return;
    var share = splitPool(pool.cents, pool.people, rotation);
    for (var name in share) totals[name] = (totals[name] || 0) + share[name];
  });
  return { totals: totals, unassigned: assigned.unassigned };
}

// ---------------------------------------------------------------------------
// Reading the sheets
// ---------------------------------------------------------------------------
/**
 * Find the tab the Form writes into. Google names this differently depending
 * on how the sheet was created ('Form Responses 1', 'Form_Responses', a custom
 * name), so we try in order rather than assuming.
 */
function findResponseSheet() {
  var ss = SpreadsheetApp.getActive();

  var exact = ss.getSheetByName(TAB.RESPONSES);
  if (exact) return exact;

  var sheets = ss.getSheets();

  for (var i = 0; i < sheets.length; i++) {
    if (/^form[\s_-]*response/i.test(sheets[i].getName())) return sheets[i];
  }

  for (var j = 0; j < sheets.length; j++) {
    if (String(sheets[j].getRange('A1').getValue()).trim().toLowerCase() === 'timestamp') {
      return sheets[j];
    }
  }

  throw new Error('Could not find the form responses tab. Expected a tab named ' +
    TAB.RESPONSES + ' or one starting with "Form Responses".');
}

/**
 * Map the header row to column indices by matching text, not position.
 *
 * Positional indices broke the moment email collection was switched on and
 * shifted every column right by one. Matching on the header means the code
 * survives reordering, added questions, and reworded labels.
 */
function mapColumns(headerRow) {
  var find = function (test) {
    for (var i = 0; i < headerRow.length; i++) {
      if (test(String(headerRow[i]).toLowerCase())) return i;
    }
    return -1;
  };

  var cols = {
    date:  find(function (h) { return h.indexOf('business') !== -1 || h.indexOf('date') !== -1; }),
    start: find(function (h) { return h.indexOf('start') !== -1; }),
    end:   find(function (h) { return h.indexOf('end') !== -1; }),
    who:   find(function (h) {
             return h.indexOf('your name') !== -1 || h.indexOf('name') !== -1 ||
                    h.indexOf('who') !== -1 || h.indexOf('worked') !== -1;
           }),
    notes: find(function (h) { return h.indexOf('note') !== -1; })
  };

  var missing = [];
  ['date', 'start', 'end', 'who'].forEach(function (k) {
    if (cols[k] === -1) missing.push(k);
  });

  if (missing.length) {
    throw new Error('Could not find these columns in the form responses: ' +
      missing.join(', ') + '. Headers seen: ' + headerRow.join(' | '));
  }

  return cols;
}

/**
 * Shift log from the Google Form.
 * Columns are located by header text, so the exact order does not matter.
 * Nothing here assumes how many stretches a day has.
 */
function readShiftLog() {
  var sheet = findResponseSheet();
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 1) return {};

  var cols = mapColumns(rows[0]);
  var byDay = {};

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[cols.date]) continue;

    var start = parseMinutes(r[cols.start]);
    var end = parseMinutes(r[cols.end]);
    if (start === null || end === null) continue;

    if (end <= start) end += 24 * 60;

    var person = String(r[cols.who] || '').trim();

    var day = normalizeDate(r[cols.date]);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({
      person: person,
      startMinutes: start,
      endMinutes: end,
      takingCents: null,
      notes: cols.notes === -1 ? '' : (r[cols.notes] || ''),
      row: i + 1,
      source: 'form'
    });
  }
  return byDay;
}

/**
 * Locate the Date, Time and Tip columns in whatever was pasted.
 *
 * Square's raw transactions export is ~20 columns wide. Rather than asking
 * the owner to delete columns before pasting — the step most likely to go
 * wrong on payday — we find the three we need by header name and ignore the
 * rest. Falls back to A/B/C if there is no recognisable header row, which is
 * what a hand-typed test sheet looks like.
 */
function mapTipColumns(headerRow) {
  var find = function (test) {
    for (var i = 0; i < headerRow.length; i++) {
      if (test(String(headerRow[i]).trim().toLowerCase())) return i;
    }
    return -1;
  };

  var cols = {
    date: find(function (h) { return h === 'date'; }),
    time: find(function (h) { return h === 'time'; }),
    tip:  find(function (h) { return h === 'tip'; })
  };

  if (cols.date === -1 || cols.time === -1 || cols.tip === -1) {
    return { date: 0, time: 1, tip: 2, guessed: true };
  }
  return cols;
}

/**
 * Square tips. Paste the whole export into the `Square Tips` tab — extra
 * columns are fine and ignored. Rows with a zero or blank tip are skipped,
 * which is most of them.
 */
function readSquareTips() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(TAB.TIPS);
  if (!sheet) return {};

  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return {};

  var cols = mapTipColumns(rows[0]);
  var byDay = {};

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[cols.date]) continue;

    var minutes = parseMinutes(r[cols.time]);
    var cents = toCents(r[cols.tip]);
    if (minutes === null || cents === null || cents === 0) continue;

    var day = normalizeDate(r[cols.date]);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({ minutes: minutes, cents: cents, row: i + 1 });
  }
  return byDay;
}

/**
 * Find the owner-shift table by its own header row ("Date | Started | Ended
 * | Keeping") rather than a fixed row number. A hardcoded row breaks the
 * moment the roster grows past it or someone inserts a row above it —
 * searching for the header survives both.
 */
function findOwnerTableStart(config) {
  var values = config.getDataRange().getValues();
  for (var i = 0; i < values.length; i++) {
    var a = String(values[i][0] || '').trim().toLowerCase();
    var b = String(values[i][1] || '').trim().toLowerCase();
    if (a === 'date' && b === 'started') return i + 2;
  }
  return null;
}

/**
 * The owner's own shifts, entered directly by the manager — never through
 * the Form. He typically works alone in the morning, so there is no
 * handoff moment where a closer could log this for him; a small table she
 * fills in herself is simpler than routing it through the staff form.
 *
 * Located by its own header row, so it survives the roster growing or the
 * table being moved. See findOwnerTableStart.
 */
function readOwnerShifts() {
  var config = SpreadsheetApp.getActive().getSheetByName(TAB.CONFIG);
  var ownerName = (config && config.getRange('B4').getValue()) || 'Ali';
  ownerName = String(ownerName).trim() || 'Ali';

  var out = {};
  if (!config) return out;

  var startRow = findOwnerTableStart(config);
  if (startRow === null) return out;

  var lastRow = config.getLastRow();
  if (lastRow < startRow) return out;

  var rows = config.getRange(startRow, 1, lastRow - startRow + 1, 4).getValues();
  rows.forEach(function (r, idx) {
    if (!r[0]) return;
    var start = parseMinutes(r[1]);
    var end = parseMinutes(r[2]);
    if (start === null || end === null) return;
    if (end <= start) end += 24 * 60;

    var takingCents = (r[3] === '' || r[3] === null) ? null : toCents(r[3]);

    var day = normalizeDate(r[0]);
    if (!out[day]) out[day] = [];
    out[day].push({
      person: ownerName,
      startMinutes: start,
      endMinutes: end,
      takingCents: takingCents,
      notes: '',
      row: startRow + idx,
      source: 'config'
    });
  });
  return out;
}

/**
 * Roster and payout channel, from the Config tab starting at row 6:
 *   A: Name (spelled exactly as in ADP)   B: 'ADP' or 'Cash'
 *
 * Trainees are not on payroll and receive their online tips as cash from the
 * register. Same allocation math, different payout channel. The owner decides
 * who is which; this sheet only records it.
 */
function readRoster() {
  var config = SpreadsheetApp.getActive().getSheetByName(TAB.CONFIG);
  var roster = {};
  if (!config) return roster;

  var rows = config.getRange('A6:B60').getValues();
  rows.forEach(function (r) {
    var name = String(r[0] || '').trim();
    if (!name) return;
    var channel = String(r[1] || '').trim().toLowerCase();
    roster[name] = (channel.indexOf('cash') === 0) ? 'Cash' : 'ADP';
  });
  return roster;
}

// ---------------------------------------------------------------------------
// The main job
// ---------------------------------------------------------------------------
function recalculate() {
  var shiftsByDay = readShiftLog();
  var ownerShiftsByDay = readOwnerShifts();
  var flags = [];

  var configSheetForCheck = SpreadsheetApp.getActive().getSheetByName(TAB.CONFIG);
  var ownerName = 'Ali';
  if (configSheetForCheck) {
    var rawOwnerName = String(configSheetForCheck.getRange('B4').getValue() || '').trim();
    if (rawOwnerName) ownerName = rawOwnerName;

    if (findOwnerTableStart(configSheetForCheck) === null) {
      flags.push(['—', 'Owner\'s shift table not found',
        'Could not find a row in Config with "Date" in column A and "Started" in ' +
        'column B. If that header row was moved, renamed, or deleted, ' +
        '"' + ownerName + '"\'s own shifts are not being read. Restore the header ' +
        'row exactly as "Date | Started | Ended | Keeping" and recalculate.']);
    }
  }

  Object.keys(ownerShiftsByDay).forEach(function (day) {
    if (!shiftsByDay[day]) shiftsByDay[day] = [];
    shiftsByDay[day] = shiftsByDay[day].concat(ownerShiftsByDay[day]);
  });

  var tipsByDay = readSquareTips();
  var roster = readRoster();
  var unknownNames = {};

  var dailyRows = [];

  var allDays = {};
  Object.keys(shiftsByDay).forEach(function (d) { allDays[d] = true; });
  Object.keys(tipsByDay).forEach(function (d) { allDays[d] = true; });

  Object.keys(allDays).sort().forEach(function (day) {
    var shifts = shiftsByDay[day] || [];
    var tips = tipsByDay[day] || [];
    var rotation = SETTINGS.ROTATE_PENNIES ? dayOfYear(day) : 0;

    checkPlausibility(day, shifts).forEach(function (f) { flags.push(f); });

    findDuplicatePeople(shifts).forEach(function (name) {
      flags.push([friendlyDate(day), name + ' filled in the form twice',
        'This is fine if they really worked two separate times that day. ' +
        'If not, delete the extra row or they will be paid twice.']);
    });

    var noName = shifts.filter(function (s) { return !s.person; });
    if (noName.length) {
      flags.push([friendlyDate(day), 'Someone left their name blank',
        'An entry at ' + sourceLabel(noName[0].source, noName[0].row) + ' has no name. ' +
        'Ask whose shift it was and type it in, spelled the same as in Config.']);
    }

    if (tips.length === 0) return;

    if (shifts.length === 0) {
      var assumedTotal = tips.reduce(function (s, t) { return s + t.cents; }, 0);

      dailyRows.push([day, ownerName, toDollars(assumedTotal)]);
      flags.push([friendlyDate(day), 'Assumed ' + ownerName + ' worked alone',
        'Nobody logged a shift, but $' + toDollars(assumedTotal).toFixed(2) + ' in tips came in. ' +
        'This was given entirely to ' + ownerName + ', assuming a normal solo day. If someone ' +
        'else actually worked and forgot to log it, add their shift and recalculate.']);
      return;
    }

    if (shifts.some(function (s) { return !s.person; })) return;

    var overrides = {};
    shifts.forEach(function (s) {
      if (s.takingCents !== null && s.takingCents !== undefined) {
        overrides[s.person] = s.takingCents;
      }
    });

    shifts.forEach(function (s) {
      if (s.notes && /\b(?:keep(?:ing|s)?|kept)\b/i.test(s.notes) && s.takingCents === null) {
        flags.push([friendlyDate(day), 'Could not read the amount ' + s.person + ' is keeping',
          'The note says "' + s.notes + '" but no dollar amount could be found in it. ' +
          'Edit the note to something like "keeping $10" and recalculate.']);
      }
    });

    var result;
    try {
      result = computeDay(shifts, tips, rotation);
      if (Object.keys(overrides).length) {
        try {
          result.totals = applyOverrides(result.totals, overrides, rotation);
        } catch (ovErr) {
          flags.push([friendlyDate(day), 'Problem with the reduced-tip amount', ovErr.message]);
        }
      }
    } catch (err) {
      flags.push([friendlyDate(day), 'Something is wrong with this day', err.message]);
      return;
    }

    if (result.unassigned.length) {
      var stray = result.unassigned.reduce(function (s, t) { return s + t.cents; }, 0);
      flags.push([friendlyDate(day),
        'Tips came in when nobody was logged as working',
        '$' + toDollars(stray).toFixed(2) + ' of tips, starting at ' +
        minutesToClock(result.unassigned[0].minutes) + '. Someone probably forgot to ' +
        'fill in the form, or typed the wrong times. Fix it and this will go away.']);
    }

    Object.keys(result.totals).sort().forEach(function (name) {
      if (!roster.hasOwnProperty(name)) unknownNames[name] = true;
      dailyRows.push([day, name, toDollars(result.totals[name])]);
    });
  });

  Object.keys(unknownNames).sort().forEach(function (name) {
    flags.push(['—', '"' + name + '" is not in the Config list',
      'They filled in the form but are not on the roster, so the sheet does not know ' +
      'whether they go into payroll. Add them to the Config tab, spelled exactly the ' +
      'same way, and choose ADP or Cash.']);
  });

  writeTab(TAB.DAILY, ['Date', 'Employee', 'Online Tips'],
    dailyRows.slice().reverse().map(function (r) {
      return [friendlyDate(r[0]), r[1], r[2]];
    }), 3);
  writeTab(TAB.FLAGS, ['Date', 'What happened', 'What to do'],
    flags.slice().reverse());
  buildPayrollSummary(dailyRows, roster);

  return { days: Object.keys(allDays).length, flags: flags.length };
}

/**
 * Catch shift times nobody actually worked.
 *
 * The dropdown on the form makes AM/PM mistakes nearly impossible on staff
 * entries, but the owner's own table is hand-typed by the manager, and
 * Sheets silently guesses AM when a time like '5:30' is typed without a
 * suffix — this is the backstop for exactly that.
 *
 * These do not stop the calculation. They ask a human to look. The location
 * named in the message depends on where the shift actually came from — the
 * Form or the owner's Config table — so the row number always points
 * somewhere real. See sourceLabel.
 */
function checkPlausibility(day, shifts) {
  var out = [];

  shifts.forEach(function (s) {
    var duration = s.endMinutes - s.startMinutes;
    var where = sourceLabel(s.source, s.row);

    if (duration > SETTINGS.MAX_SHIFT_MINUTES) {
      out.push([friendlyDate(day), (s.person || 'Someone') + ' has a very long shift',
        minutesToClock(s.startMinutes) + ' to ' + minutesToClock(s.endMinutes % (24 * 60)) +
        ' is ' + (duration / 60).toFixed(1) + ' hours. This is almost always an AM/PM ' +
        'mix-up on the end time — type "5:30 PM" rather than just "5:30" so Sheets ' +
        'cannot guess wrong. See ' + where + '.']);
    }

    if (s.startMinutes < SETTINGS.EARLIEST_START) {
      out.push([friendlyDate(day), (s.person || 'Someone') + ' started before the shop opens',
        'The entry says ' + minutesToClock(s.startMinutes) + '. Check the AM/PM on the ' +
        'start time. See ' + where + '.']);
    }

    if (s.endMinutes > SETTINGS.LATEST_END && duration <= SETTINGS.MAX_SHIFT_MINUTES) {
      out.push([friendlyDate(day), (s.person || 'Someone') + ' finished after the shop closes',
        'The entry says ' + minutesToClock(s.endMinutes % (24 * 60)) + '. Check the AM/PM ' +
        'on the end time. See ' + where + '.']);
    }
  });

  return out;
}

/**
 * A quick check the manager runs right before payroll — not the owner.
 * Lists every shift entry for whichever name is treated as the owner
 * (Config!B4, or 'Ali' if blank) so she can confirm at a glance that any
 * reduced-tip entries were read correctly before he ever sees the output.
 */
function ownerPrecheck() {
  var config = SpreadsheetApp.getActive().getSheetByName(TAB.CONFIG);
  var ownerName = (config && config.getRange('B4').getValue()) || 'Ali';
  ownerName = String(ownerName).trim() || 'Ali';

  var byDay = readOwnerShifts();
  var rows = [];

  Object.keys(byDay).sort().forEach(function (day) {
    byDay[day].forEach(function (s) {
      var status = s.takingCents !== null
        ? 'Keeping ' + toDollars(s.takingCents).toFixed(2)
        : 'Full share';
      rows.push([friendlyDate(day), minutesToClock(s.startMinutes),
                 minutesToClock(s.endMinutes % (24 * 60)), status]);
    });
  });

  writeTab('Owner Pre-Payroll Check',
    ['Date', 'Start', 'End', 'What he is getting'], rows);

  SpreadsheetApp.getUi().alert(
    rows.length
      ? 'Found ' + rows.length + ' entr' + (rows.length === 1 ? 'y' : 'ies') +
        ' for "' + ownerName + '" in Config. Check the "Owner Pre-Payroll Check" ' +
        'tab before running Recalculate for payroll.'
      : 'No entries found for "' + ownerName + '" in Config yet.');
}

function writeTab(name, headers, rows, moneyCol) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    if (moneyCol) sheet.getRange(2, moneyCol, rows.length, 1).setNumberFormat('$#,##0.00');
  }
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

/**
 * Which semi-monthly pay period a date falls in.
 *
 * The shop pays on the 15th and the last day of the month, so periods are
 * the 1st-15th and the 16th-end of month. This is NOT the same as biweekly:
 * semi-monthly is 24 periods a year on fixed dates, biweekly is 26 on a
 * rolling 14-day cycle. They drift apart within weeks.
 */
function payPeriodLabel(dateStr) {
  var d = new Date(dateStr + 'T12:00:00');
  var year = d.getFullYear();
  var month = d.getMonth();
  var day = d.getDate();

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var ym = year + '-' + pad(month + 1);

  if (day <= 15) return ym + '-01 to ' + ym + '-15';

  var lastDay = new Date(year, month + 1, 0).getDate();
  return ym + '-16 to ' + ym + '-' + pad(lastDay);
}

/**
 * Roll daily splits into semi-monthly pay periods.
 * Grouped by payout channel: ADP rows are what the owner keys into payroll,
 * Cash rows are what was already handed over in person.
 */
function buildPayrollSummary(dailyRows, roster) {
  var buckets = {};
  dailyRows.forEach(function (row) {
    var label = payPeriodLabel(row[0]);
    if (!buckets[label]) buckets[label] = {};
    buckets[label][row[1]] = (buckets[label][row[1]] || 0) + Math.round(row[2] * 100);
  });

  var out = [];
  Object.keys(buckets).sort().reverse().forEach(function (label) {
    var names = Object.keys(buckets[label]);

    var enterInAdp = function (n) {
      if (!roster || !roster.hasOwnProperty(n)) return '? CHECK CONFIG';
      return roster[n] === 'Cash' ? 'No — you pay directly' : 'Yes';
    };

    names.sort(function (a, b) {
      var ca = enterInAdp(a), cb = enterInAdp(b);
      return ca === cb ? (a < b ? -1 : 1) : (ca < cb ? -1 : 1);
    });

    names.forEach(function (name) {
      out.push([friendlyPeriod(label), name, toDollars(buckets[label][name]), enterInAdp(name)]);
    });
  });

  writeTab(TAB.PAYROLL,
    ['Pay Period', 'Employee', 'Total Online Tips', 'Enter in ADP?'], out, 3);
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
/**
 * Show what the script is actually reading from both tabs, and where they
 * fail to line up. Run this first whenever a day produces no split.
 */
function diagnose() {
  var out = [];

  try {
    var sheet = findResponseSheet();
    out.push('Response tab: "' + sheet.getName() + '"');
    var headers = sheet.getDataRange().getValues()[0];
    var cols = mapColumns(headers);
    out.push('Columns found: date=' + cols.date + ' start=' + cols.start +
             ' end=' + cols.end + ' who=' + cols.who);
  } catch (err) {
    out.push('PROBLEM reading the form tab: ' + err.message);
  }

  var shiftDays, tipDays;
  try { shiftDays = Object.keys(readShiftLog()).sort(); }
  catch (err) { shiftDays = []; out.push('PROBLEM: ' + err.message); }

  try { tipDays = Object.keys(readSquareTips()).sort(); }
  catch (err) { tipDays = []; out.push('PROBLEM: ' + err.message); }

  try {
    var tipSheet = SpreadsheetApp.getActive().getSheetByName(TAB.TIPS);
    if (tipSheet) {
      var tipHeaders = tipSheet.getDataRange().getValues()[0] || [];
      var tc = mapTipColumns(tipHeaders);
      out.push(tc.guessed
        ? 'Square Tips: no Date/Time/Tip headers found — assuming columns A, B, C.'
        : 'Square Tips: Date=col ' + tc.date + ', Time=col ' + tc.time + ', Tip=col ' + tc.tip);
    }
  } catch (err) {
    out.push('PROBLEM reading Square Tips: ' + err.message);
  }

  out.push('');
  out.push('Dates in the shift log (' + shiftDays.length + '):');
  out.push(shiftDays.length ? shiftDays.join(', ') : '  none');
  out.push('');
  out.push('Dates in Square Tips (' + tipDays.length + '):');
  out.push(tipDays.length ? tipDays.join(', ') : '  none');

  var tipsOnly = tipDays.filter(function (d) { return shiftDays.indexOf(d) === -1; });
  var shiftsOnly = shiftDays.filter(function (d) { return tipDays.indexOf(d) === -1; });

  out.push('');
  if (!tipsOnly.length && !shiftsOnly.length && shiftDays.length) {
    out.push('Every date matches on both sides.');
  } else {
    if (tipsOnly.length) out.push('Tips with no matching shift: ' + tipsOnly.join(', '));
    if (shiftsOnly.length) out.push('Shifts with no matching tips: ' + shiftsOnly.join(', '));
    out.push('');
    out.push('If a date appears on both lists in different forms, the two tabs ' +
             'are storing dates differently.');
  }

  SpreadsheetApp.getUi().alert('Diagnostics', out.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

function onFormSubmit() {
  try { recalculate(); }
  catch (err) { notify('Tip sheet hit an error', String(err)); }
}

/**
 * Fires when the sheet is edited by hand — which in practice means someone
 * pasting the export into Square Tips. Without this the owner would have to
 * remember to press a button, and "remember to press a button" is exactly
 * the kind of step that gets skipped.
 *
 * Guarded to the tips tab so ordinary edits elsewhere don't trigger a rebuild.
 */
function onSheetChange(e) {
  try {
    var sheet = SpreadsheetApp.getActive().getActiveSheet();
    if (sheet && sheet.getName() === TAB.TIPS) recalculate();
  } catch (err) {
    notify('Tip sheet hit an error', String(err));
  }
}

/**
 * Previously emailed nightly if nobody had logged a shift that day. Retired:
 * once the owner began routinely working solo without ever touching the
 * form, an unlogged day became his NORMAL day rather than a mistake, and
 * the nightly check has no way to tell the two apart — it runs before tips
 * exist, so it can't yet know whether the day was really covered. Kept as a
 * callable function in case it's wanted again later (e.g. paired with a
 * real schedule feed), but no trigger calls it automatically anymore.
 *
 * The actual safety net moved to recalculate(): an unlogged day WITH tips is
 * now flagged as "Assumed [owner] worked alone" for the manager to review at
 * payroll, when there is enough information (the tip total) to judge it.
 */
function nightlyCheck() {
  if (SETTINGS.CLOSED_DAYS.indexOf(new Date().getDay()) !== -1) return;

  var today = normalizeDate(new Date());
  var log = readShiftLog();
  var ownerLog = readOwnerShifts();

  var loggedByStaff = log[today] && log[today].length;
  var loggedByOwner = ownerLog[today] && ownerLog[today].length;

  if (!loggedByStaff && !loggedByOwner) {
    notify('No shift logged today',
      'Nobody filled in the shift form for ' + today + ', and nothing is in ' +
      'the owner\'s own table either. Online tips for today cannot be ' +
      'allocated until someone logs it.');
  }
}

function notify(subject, body) {
  var config = SpreadsheetApp.getActive().getSheetByName(TAB.CONFIG);
  var to = config ? config.getRange('B3').getValue() : '';
  if (!to) return;
  MailApp.sendEmail({
    to: String(to),
    subject: 'YERSEN tips — ' + subject,
    body: body + '\n\n' + SpreadsheetApp.getActive().getUrl()
  });
}

/**
 * Build the tabs this script needs, with headers and instructions in place.
 * Safe to run more than once — it never overwrites a tab that already
 * exists, so a second run cannot wipe a roster you have already filled in.
 *
 * Run this once, right after pasting the code.
 */
function setupSheet() {
  var ss = SpreadsheetApp.getActive();
  var created = [];

  if (!ss.getSheetByName(TAB.CONFIG)) {
    var config = ss.insertSheet(TAB.CONFIG);
    config.getRange('A1').setValue('Setting').setFontWeight('bold');
    config.getRange('B1').setValue('Value').setFontWeight('bold');

    config.getRange('A2').setValue('Pay periods (fixed: 1st-15th, 16th-EOM — this row is unused, safe to ignore)');
    config.getRange('B2').setValue('semi-monthly');
    config.getRange('A3').setValue('Alert email');
    config.getRange('A4').setValue('Owner\'s name (used to label owner entries and flags)');
    config.getRange('B4').setValue('Ali');

    config.getRange('A5').setValue('Name (spelled exactly as in ADP)').setFontWeight('bold');
    config.getRange('B5').setValue('Paid via').setFontWeight('bold');

    config.getRange('A13').setValue(
      'Owner\'s own shifts — enter directly, he does not use the staff form. ' +
      'Always type times WITH am/pm (e.g. "5:30 PM"), never just "5:30".')
      .setFontWeight('bold');
    config.getRange('A14:D14')
      .setValues([['Date', 'Started', 'Ended', 'Keeping (blank = full share)']])
      .setFontWeight('bold');

    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['ADP', 'Cash'], true)
      .setAllowInvalid(false)
      .build();
    config.getRange('B6:B60').setDataValidation(rule);

    config.getRange('D1').setValue(
      'Roster goes in A6 downward. ADP = tips entered into payroll. ' +
      'Cash = trainee, already handed their tips at the end of each shift.');
    config.setColumnWidth(1, 260);
    config.setColumnWidth(2, 120);
    created.push(TAB.CONFIG);
  }

  if (!ss.getSheetByName(TAB.TIPS)) {
    var tips = ss.insertSheet(TAB.TIPS);
    tips.getRange('A1:C1').setValues([['Date', 'Time', 'Tip']]).setFontWeight('bold');
    tips.setFrozenRows(1);
    tips.getRange('E1').setValue(
      'Paste the whole Square transactions export here, including its header row. ' +
      'Extra columns are fine — the sheet finds Date, Time and Tip by name. ' +
      'Rows with no tip are ignored.');
    tips.setColumnWidth(1, 110);
    tips.setColumnWidth(2, 110);
    created.push(TAB.TIPS);
  }

  ['Daily Splits', 'Payroll Summary', 'Flags'].forEach(function (name) {
    if (!ss.getSheetByName(name)) { ss.insertSheet(name); created.push(name); }
  });

  SpreadsheetApp.getUi().alert(
    created.length
      ? 'Created: ' + created.join(', ') + '\n\nNow fill in the Config tab, then run "Install triggers".'
      : 'Everything already exists. Nothing changed.');
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('onSheetChange').forSpreadsheet(ss).onChange().create();
  SpreadsheetApp.getUi().alert(
    'Triggers installed.\n\nTips now recalculate automatically when a form is ' +
    'submitted and when the Square Tips tab is edited.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tips')
    .addItem('1. Set up tabs', 'setupSheet')
    .addItem('2. Install triggers', 'setupTriggers')
    .addSeparator()
    .addItem('Recalculate now', 'recalculate')
    .addItem('Check owner\'s reduced-tip entries', 'ownerPrecheck')
    .addSeparator()
    .addItem('Diagnose (why is a day not splitting?)', 'diagnose')
    .addToUi();
}
