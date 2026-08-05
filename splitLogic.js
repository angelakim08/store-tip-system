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
 * Two crews cannot both own the same minute of tips. Overlapping stretches
 * are a logging mistake, not something to average out.
 */
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
  module.exports = { splitPool, assignTips, findOverlaps, computeDay, applyOverrides, sumCents };
}
