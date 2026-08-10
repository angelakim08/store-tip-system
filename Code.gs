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
 *   Config             roster, pay period anchor, alert email
 *   Daily Splits       generated
 *   Payroll Summary    generated — what the owner opens on payday
 *   Flags              generated — anything needing a human
 *
 * SETUP
 *   Extensions > Apps Script, paste this in, Save, run `setupTriggers` once.
 */

var SETTINGS = {
  // Orphan pennies rotate by day so the same person isn't always up a cent.
  ROTATE_PENNIES: true,

  // Hour (24h, shop local) for the nightly "did anyone log their shift?" check.
  NIGHTLY_CHECK_HOUR: 22,

  // 0 = Sunday. Days the shop is closed, so the nightly check stays quiet.
  CLOSED_DAYS: [],

  // Sanity bounds for a shift. Set these to the shop's real hours with about
  // an hour of slack either side — the tighter they are, the more AM/PM slips
  // get caught. Any flip within these hours still surfaces as unassigned tips.
  EARLIEST_START: 10 * 60,   // 10:00 AM — set to opening time minus ~1hr
  LATEST_END: 22 * 60,       // 10:00 PM — set to closing time plus ~1hr
  MAX_SHIFT_MINUTES: 12 * 60,

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

  // Already yyyy-mm-dd (possibly with a time appended)
  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return iso[1] + '-' + pad(parseInt(iso[2], 10)) + '-' + pad(parseInt(iso[3], 10));

  // m/d/yyyy or mm/dd/yyyy
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
    // A window nobody covered is a real gap. Dropping it means tips inside
    // come back unassigned and get flagged, not handed to whoever was nearby.
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

  // Last resort: any tab whose first cell is 'Timestamp' — the Form always
  // writes that header, whatever the tab ends up being called.
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

    // A stretch ending before it starts crossed midnight. Extend past 24h so
    // the window still contains late tips rather than silently matching none.
    if (end <= start) end += 24 * 60;

    var person = String(r[cols.who] || '').trim();

    var day = normalizeDate(r[cols.date]);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({
      person: person,
      startMinutes: start,
      endMinutes: end,
      notes: cols.notes === -1 ? '' : (r[cols.notes] || ''),
      row: i + 1
    });
  }
  return byDay;
}

/**
 * Square tips. Paste the export into the `Square Tips` tab.
 * Columns: Date | Time | Tip amount   (header row expected)
 * Rows with a zero or blank tip are ignored, which is most of them.
 */
function readSquareTips() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(TAB.TIPS);
  if (!sheet) return {};

  var rows = sheet.getDataRange().getValues();
  var byDay = {};

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;

    var minutes = parseMinutes(r[1]);
    var cents = toCents(r[2]);
    if (minutes === null || cents === null || cents === 0) continue;

    var day = normalizeDate(r[0]);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({ minutes: minutes, cents: cents, row: i + 1 });
  }
  return byDay;
}

/**
 * Roster and payout channel, from the Config tab starting at row 6:
 *   A: Name (spelled exactly as in ADP)   B: 'ADP' or 'Cash'
 *
 * Trainees are not on payroll and receive their online tips as cash from the
 * register. Same allocation math, different payout channel. The owner decides who
 * is which; this sheet only records it.
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
  var tipsByDay = readSquareTips();
  var roster = readRoster();
  var unknownNames = {};

  var flags = [];
  var dailyRows = [];

  var allDays = {};
  Object.keys(shiftsByDay).forEach(function (d) { allDays[d] = true; });
  Object.keys(tipsByDay).forEach(function (d) { allDays[d] = true; });

  Object.keys(allDays).sort().forEach(function (day) {
    var shifts = shiftsByDay[day] || [];
    var tips = tipsByDay[day] || [];
    var rotation = SETTINGS.ROTATE_PENNIES ? dayOfYear(day) : 0;

    if (tips.length === 0) return; // no online tips that day, nothing to split

    if (shifts.length === 0) {
      var total = tips.reduce(function (s, t) { return s + t.cents; }, 0);
      flags.push([friendlyDate(day), 'Nobody filled in the form for this day',
        'Square shows $' + toDollars(total).toFixed(2) + ' in tips. Ask who worked, ' +
        'have them fill in the form, and these tips will be shared out.']);
      return;
    }

    var empty = shifts.filter(function (s) { return !s.person; });
    if (empty.length) {
      flags.push([friendlyDate(day), 'Someone left their name blank',
        'Row ' + empty[0].row + ' of the form responses has no name. Ask whose shift ' +
        'it was and type it in, spelled the same as in Config.']);
      return;
    }

    checkPlausibility(day, shifts).forEach(function (f) { flags.push(f); });

    findDuplicatePeople(shifts).forEach(function (name) {
      flags.push([friendlyDate(day), name + ' filled in the form twice',
        'This is fine if they really worked two separate times that day. ' +
        'If not, delete the extra row or they will be paid twice.']);
    });

    var result;
    try {
      result = computeDay(shifts, tips, rotation);
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

  // A name in the shift log that is not on the roster means either a new hire
  // nobody added, or a spelling that will not match ADP. Both pay someone wrong.
  Object.keys(unknownNames).sort().forEach(function (name) {
    flags.push(['—', '"' + name + '" is not in the Config list',
      'They filled in the form but are not on the roster, so the sheet does not know ' +
      'whether they go into payroll. Add them to the Config tab, spelled exactly the ' +
      'same way, and choose ADP or Cash.']);
  });

  // slice() first — reverse() mutates, and dailyRows is passed on below.
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
 * The dropdown on the form makes AM/PM mistakes nearly impossible, but this
 * is the backstop for anything that slips through — a 5:30 AM start, or a
 * shift that runs fifteen hours because someone picked AM for the end time.
 *
 * These do not stop the calculation. They ask a human to look.
 */
function checkPlausibility(day, shifts) {
  var out = [];

  shifts.forEach(function (s) {
    var duration = s.endMinutes - s.startMinutes;

    if (duration > SETTINGS.MAX_SHIFT_MINUTES) {
      out.push([friendlyDate(day), (s.person || 'Someone') + ' has a very long shift',
        minutesToClock(s.startMinutes) + ' to ' + minutesToClock(s.endMinutes % (24 * 60)) +
        ' is ' + (duration / 60).toFixed(1) + ' hours. This is almost always an AM/PM ' +
        'mix-up on the end time. Row ' + s.row + ' of the form responses.']);
    }

    if (s.startMinutes < SETTINGS.EARLIEST_START) {
      out.push([friendlyDate(day), (s.person || 'Someone') + ' started before the shop opens',
        'The form says ' + minutesToClock(s.startMinutes) + '. Check the AM/PM on the ' +
        'start time. Row ' + s.row + ' of the form responses.']);
    }

    if (s.endMinutes > SETTINGS.LATEST_END && duration <= SETTINGS.MAX_SHIFT_MINUTES) {
      out.push([friendlyDate(day), (s.person || 'Someone') + ' finished after the shop closes',
        'The form says ' + minutesToClock(s.endMinutes % (24 * 60)) + '. Check the AM/PM ' +
        'on the end time. Row ' + s.row + ' of the form responses.']);
    }
  });

  return out;
}

function writeTab(name, headers, rows, moneyCol) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    // Dollars, so '35' reads as '$35.00' rather than looking like a count.
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
  // Newest period first. The owner opens this on payday and needs the current
  // period at the top, not buried under a year of settled ones.
  Object.keys(buckets).sort().reverse().forEach(function (label) {
    var names = Object.keys(buckets[label]);

    // The action column is a short answer to one question: does this go into
    // payroll? Long explanatory text belongs in the guide, not on the page
    // someone reads at 11pm while keying numbers.
    // '?' when someone is missing from Config — visible, never guessed as Yes.
    var enterInAdp = function (n) {
      if (!roster || !roster.hasOwnProperty(n)) return '? CHECK CONFIG';
      return roster[n] === 'Cash' ? 'No — you pay directly' : 'Yes';
    };

    // ADP people first so the rows to key in are contiguous.
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
 * remember to press a button, and "remember to press a button" is exactly the
 * kind of step that gets skipped.
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

/** Nightly backstop. The end-of-day checklist is the real fix. */
function nightlyCheck() {
  if (SETTINGS.CLOSED_DAYS.indexOf(new Date().getDay()) !== -1) return;

  var today = normalizeDate(new Date());
  var log = readShiftLog();

  if (!log[today] || !log[today].length) {
    notify('No shift logged today',
      'Nobody filled in the shift form for ' + today + '. ' +
      'Online tips for today cannot be allocated until someone does.');
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
 * Safe to run more than once — it never overwrites a tab that already exists,
 * so a second run cannot wipe a roster you have already filled in.
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

    config.getRange('A2').setValue('Pay periods (fixed: 1st-15th, 16th-EOM)');
    config.getRange('B2').setValue('semi-monthly');
    config.getRange('A3').setValue('Alert email');

    config.getRange('A5').setValue('Name (spelled exactly as in ADP)').setFontWeight('bold');
    config.getRange('B5').setValue('Paid via').setFontWeight('bold');

    // Drop-down so nobody types 'cash ' or 'adp.' and breaks the match.
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
      'Paste the Square export here. Date in A, time in B, tip amount in C. ' +
      'Rows with no tip are ignored. Extra columns to the right are fine.');
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
  ScriptApp.newTrigger('nightlyCheck').timeBased()
    .atHour(SETTINGS.NIGHTLY_CHECK_HOUR).everyDays(1).create();
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
    .addSeparator()
    .addItem('Diagnose (why is a day not splitting?)', 'diagnose')
    .addToUi();
}
