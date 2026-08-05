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

/** Minutes past midnight. Google returns Dates sometimes and strings others. */
function parseMinutes(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (value instanceof Date) return value.getHours() * 60 + value.getMinutes();

  var m = String(value).match(/(\d{1,2}):(\d{2})\s*([apAP])?/);
  if (!m) return null;
  var h = parseInt(m[1], 10);
  var suffix = m[3] ? m[3].toLowerCase() : '';
  if (suffix === 'p' && h < 12) h += 12;
  if (suffix === 'a' && h === 12) h = 0;
  return h * 60 + parseInt(m[2], 10);
}

function dayKey(date) {
  return Utilities.formatDate(date, SETTINGS.TZ, 'yyyy-MM-dd');
}

function normalizeDate(value) {
  if (value instanceof Date) return dayKey(value);
  return String(value).trim();
}

function dayOfYear(dateStr) {
  var d = new Date(dateStr + 'T12:00:00');
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
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

function findOverlaps(stretches) {
  var sorted = stretches.slice().sort(function (a, b) { return a.startMinutes - b.startMinutes; });
  var problems = [];
  for (var i = 1; i < sorted.length; i++) {
    if (sorted[i].startMinutes < sorted[i - 1].endMinutes) {
      problems.push({ first: sorted[i - 1], second: sorted[i] });
    }
  }
  return problems;
}

function computeDay(stretches, tips, rotation) {
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
    who:   find(function (h) { return h.indexOf('who') !== -1 || h.indexOf('worked') !== -1; }),
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

    var people = String(r[cols.who] || '').split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });

    var day = normalizeDate(r[cols.date]);
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push({
      startMinutes: start,
      endMinutes: end,
      people: people,
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
    var stretches = shiftsByDay[day] || [];
    var tips = tipsByDay[day] || [];
    var rotation = SETTINGS.ROTATE_PENNIES ? dayOfYear(day) : 0;

    if (tips.length === 0) return; // no online tips that day, nothing to split

    if (stretches.length === 0) {
      var total = tips.reduce(function (s, t) { return s + t.cents; }, 0);
      flags.push([day, 'No shift logged',
        'Square shows $' + toDollars(total).toFixed(2) + ' in tips but nobody logged a shift. ' +
        'These tips cannot be paid out until someone fills in the form for this day.']);
      return;
    }

    var empty = stretches.filter(function (s) { return s.people.length === 0; });
    if (empty.length) {
      flags.push([day, 'Nobody listed',
        'The stretch on row ' + empty[0].row + ' has no names checked. It cannot be split.']);
      return;
    }

    findOverlaps(stretches).forEach(function (o) {
      flags.push([day, 'Stretches overlap',
        minutesToClock(o.first.startMinutes) + '-' + minutesToClock(o.first.endMinutes) +
        ' overlaps ' + minutesToClock(o.second.startMinutes) + '-' +
        minutesToClock(o.second.endMinutes) + '. Two crews cannot both own the same tips.']);
    });

    var result;
    try {
      result = computeDay(stretches, tips, rotation);
    } catch (err) {
      flags.push([day, 'Allocation refused to run', err.message]);
      return;
    }

    if (result.unassigned.length) {
      var stray = result.unassigned.reduce(function (s, t) { return s + t.cents; }, 0);
      flags.push([day, 'Tips outside every shift',
        '$' + toDollars(stray).toFixed(2) + ' came in when nobody was logged as working ' +
        '(first one at ' + minutesToClock(result.unassigned[0].minutes) + '). ' +
        'Either a stretch was not logged, or the logged times are wrong.']);
    }

    Object.keys(result.totals).sort().forEach(function (name) {
      if (!roster.hasOwnProperty(name)) unknownNames[name] = true;
      dailyRows.push([day, name, toDollars(result.totals[name])]);
    });
  });

  // A name in the shift log that is not on the roster means either a new hire
  // nobody added, or a spelling that will not match ADP. Both pay someone wrong.
  Object.keys(unknownNames).sort().forEach(function (name) {
    flags.push(['—', 'Name not on the roster',
      '"' + name + '" appears in the shift log but is not listed in Config. ' +
      'Add them to Config with ADP or Cash, spelled exactly as in ADP.']);
  });

  // slice() first — reverse() mutates, and dailyRows is passed on below.
  writeTab(TAB.DAILY, ['Business Date', 'Employee', 'Online Tips'],
    dailyRows.slice().reverse());
  writeTab(TAB.FLAGS, ['Business Date', 'Problem', 'What to do'],
    flags.slice().reverse());
  buildPayrollSummary(dailyRows, roster);

  return { days: Object.keys(allDays).length, flags: flags.length };
}

function writeTab(name, headers, rows) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

/**
 * Roll daily splits into 14-day pay periods anchored on Config!B2.
 * Grouped by payout channel: ADP rows are what the owner keys into payroll,
 * Cash rows are what he hands over in person.
 */
function buildPayrollSummary(dailyRows, roster) {
  var config = SpreadsheetApp.getActive().getSheetByName(TAB.CONFIG);
  var anchor = config ? config.getRange('B2').getValue() : null;
  if (!(anchor instanceof Date)) anchor = new Date('2026-01-01T12:00:00');

  var buckets = {};
  dailyRows.forEach(function (row) {
    var d = new Date(row[0] + 'T12:00:00');
    var periods = Math.floor((d - anchor) / (14 * 86400000));
    var start = new Date(anchor.getTime() + periods * 14 * 86400000);
    var end = new Date(start.getTime() + 13 * 86400000);
    var label = dayKey(start) + ' to ' + dayKey(end);

    if (!buckets[label]) buckets[label] = {};
    buckets[label][row[1]] = (buckets[label][row[1]] || 0) + Math.round(row[2] * 100);
  });

  var out = [];
  // Newest period first. The owner opens this on payday and needs the current
  // period at the top, not buried under a year of settled ones.
  Object.keys(buckets).sort().reverse().forEach(function (label) {
    var names = Object.keys(buckets[label]);

    // Cash people are trainees, paid their tips in person at the end of each
    // shift. Their row is a RECORD of money already handed over, not an
    // instruction to pay — the label says so explicitly so nobody double-pays.
    // '?' when someone is missing from Config — visible, never guessed as ADP.
    var channelOf = function (n) {
      if (!roster || !roster.hasOwnProperty(n)) return '? — not in Config';
      return roster[n] === 'Cash' ? 'Cash — already paid nightly' : 'ADP — enter in payroll';
    };

    names.sort(function (a, b) {
      var ca = channelOf(a), cb = channelOf(b);
      return ca === cb ? (a < b ? -1 : 1) : (ca < cb ? -1 : 1);
    });

    names.forEach(function (name) {
      out.push([label, channelOf(name), name, toDollars(buckets[label][name])]);
    });
  });

  writeTab(TAB.PAYROLL,
    ['Pay Period', 'Paid via', 'Employee', 'Total Online Tips'], out);
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------
function onFormSubmit() {
  try { recalculate(); }
  catch (err) { notify('Tip sheet hit an error', String(err)); }
}

/** Nightly backstop. The end-of-day checklist is the real fix. */
function nightlyCheck() {
  if (SETTINGS.CLOSED_DAYS.indexOf(new Date().getDay()) !== -1) return;

  var today = dayKey(new Date());
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

    config.getRange('A2').setValue('Pay period start (any known one)');
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
  ScriptApp.newTrigger('nightlyCheck').timeBased()
    .atHour(SETTINGS.NIGHTLY_CHECK_HOUR).everyDays(1).create();
  SpreadsheetApp.getUi().alert('Triggers installed.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Tips')
    .addItem('1. Set up tabs', 'setupSheet')
    .addItem('2. Install triggers', 'setupTriggers')
    .addSeparator()
    .addItem('Recalculate now', 'recalculate')
    .addToUi();
}
