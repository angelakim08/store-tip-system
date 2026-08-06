/**
 * YERSEN online tip allocation — pure computation, no Google dependencies.
 *
 * SCOPE: online/card tips from Square only. Physical cash tips are split
 * evenly by hand and are deliberately not modeled here.
 *
 * The shape of the problem:
 *   Square knows HOW MUCH and WHEN.  The shift log knows WHO.
 *   This file joins them.
 *
 * Money is integer cents throughout. Never floats.
 */

/**
 * Turn individually logged shifts into the stretches tips get split across.
 *
 * Each person reports only their own in/out. Everyone's boundaries are pooled,
 * sorted, and the day is cut at every one of them. Between any two adjacent
 * boundaries the crew is constant, so that window is a stretch and whoever was
 * present shares its tips.
 *
 * This is why nobody has to know anyone else's hours. A five-minute overlap
 * falls out of the arithmetic rather than requiring someone to notice it.
 *
 * @param {Array} shifts [{ person, startMinutes, endMinutes }, ...]
 * @returns {Array} [{ startMinutes, endMinutes, people[] }, ...]
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
    var from = points[i];
    var to = points[i + 1];

    var people = [];
    shifts.forEach(function (s) {
      if (s.startMinutes <= from && s.endMinutes >= to) {
        if (people.indexOf(s.person) === -1) people.push(s.person);
      }
    });

    // A window nobody covered is a genuine gap in the day. Dropping it means
    // any tips inside it come back as unassigned and get flagged, rather than
    // being handed to whoever worked nearby.
    if (people.length) {
      stretches.push({ startMinutes: from, endMinutes: to, people: people });
    }
  }

  return stretches;
}

/**
 * Someone logging themselves twice for one day would count double in every
 * overlapping window. Real, and worth flagging rather than silently paying.
 */
function findDuplicatePeople(shifts) {
  var seen = {}, dupes = [];
  shifts.forEach(function (s) {
    if (seen[s.person]) {
      if (dupes.indexOf(s.person) === -1) dupes.push(s.person);
    }
    seen[s.person] = true;
  });
  return dupes;
}

/**
 * Split one stretch's tips evenly, truncating to the cent, then handing out
 * the orphan pennies deterministically so the total reconciles exactly.
 */
function splitPool(poolCents, people, rotation) {
  if (!people || people.length === 0) throw new Error('Cannot split a pool with nobody assigned.');
  if (poolCents < 0) throw new Error('Negative pool: ' + poolCents + ' cents.');

  var n = people.length;
  var base = Math.floor(poolCents / n);
  var leftover = poolCents - base * n;
  var ordered = people.slice().sort();

  var out = {};
  for (var i = 0; i < n; i++) out[ordered[i]] = base;
  for (var k = 0; k < leftover; k++) out[ordered[(rotation + k) % n]] += 1;
  return out;
}

/**
 * Match each Square tip to the stretch it happened during.
 *
 * A stretch covers [startMinutes, endMinutes). Half-open on purpose: a tip at
 * exactly 5:30pm belongs to the incoming crew, not the outgoing one, so a
 * handoff can never double-count.
 */
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
 * Full day: individually logged shifts + timestamped tips -> { name: cents }.
 */
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

/**
 * Voluntary reductions (the owner taking less than their share). Freed money is
 * redistributed so the day still reconciles to what Square collected.
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

function sumCents(totals) {
  var t = 0;
  for (var k in totals) t += totals[k];
  return t;
}

if (typeof module !== 'undefined') {
  module.exports = { splitPool, buildStretches, findDuplicatePeople, assignTips, computeDay, applyOverrides, sumCents };
}
