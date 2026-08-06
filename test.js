/**
 * Tests for the tip allocation logic.
 *
 *   node test.js
 *
 * Names are placeholders. Real staff names live only in the shop's private
 * Config tab, never in this repository.
 */

const { splitPool, buildStretches, findDuplicatePeople, assignTips, computeDay, applyOverrides, sumCents } = require('./splitLogic');

const A = 'Employee A';
const B = 'Employee B';
const C = 'Employee C';
const D = 'Employee D';

let pass = 0, fail = 0;

/** Compare objects by sorted keys so a change in insertion order can't fail a test. */
const norm = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return JSON.stringify(v);
  return JSON.stringify(Object.keys(v).sort().reduce((o, k) => (o[k] = v[k], o), {}));
};

const check = (label, actual, expected) => {
  if (norm(actual) === norm(expected)) { pass++; console.log('  PASS  ' + label); }
  else {
    fail++;
    console.log('  FAIL  ' + label + '\n        got      ' + norm(actual) +
                '\n        expected ' + norm(expected));
  }
};

const checkThrows = (label, fn) => {
  try { fn(); fail++; console.log('  FAIL  ' + label + ' (expected an error)'); }
  catch { pass++; console.log('  PASS  ' + label); }
};

const hm = (h, m) => h * 60 + (m || 0);

console.log('\n--- orphan pennies reconcile ---');
check('47.00 / 3 sums back to 4700', sumCents(splitPool(4700, [A, B, C], 0)), 4700);
check('45.00 / 3 is clean', splitPool(4500, [A, B, C], 0),
  { [A]: 1500, [B]: 1500, [C]: 1500 });
check('rotation moves the odd penny',
  splitPool(4700, [A, B, C], 0)[A] !== splitPool(4700, [A, B, C], 1)[A], true);

console.log('\n--- A works 2-9, B joins at 5:30 ---');
const day = computeDay(
  [
    { person: A, startMinutes: hm(14), endMinutes: hm(21) },
    { person: B, startMinutes: hm(17, 30), endMinutes: hm(21) },
  ],
  [
    { minutes: hm(15, 12), cents: 300 },
    { minutes: hm(16, 40), cents: 500 },
    { minutes: hm(18, 5), cents: 400 },
    { minutes: hm(20, 30), cents: 600 },
  ], 0);
check('A: 8.00 solo + half of 10.00', day.totals[A], 1300);
check('B: half of 10.00', day.totals[B], 500);
check('nothing unassigned', day.unassigned.length, 0);

console.log('\n--- a tip exactly at handoff goes to the incoming crew ---');
const edge = computeDay(
  [
    { person: A, startMinutes: hm(14), endMinutes: hm(21) },
    { person: B, startMinutes: hm(17, 30), endMinutes: hm(21) },
  ],
  [{ minutes: hm(17, 30), cents: 1000 }], 0);
check('5:30 tip is split, not solo', edge.totals, { [A]: 500, [B]: 500 });

console.log('\n--- three stretches in one day ---');
const summer = computeDay(
  [
    { person: C, startMinutes: hm(11), endMinutes: hm(14) },
    { person: A, startMinutes: hm(14), endMinutes: hm(21) },
    { person: D, startMinutes: hm(17), endMinutes: hm(21) },
  ],
  [
    { minutes: hm(12), cents: 2000 },
    { minutes: hm(15), cents: 3000 },
    { minutes: hm(19), cents: 4000 },
  ], 0);
check('three stretches allocate correctly', summer.totals,
  { [C]: 2000, [A]: 5000, [D]: 2000 });

console.log('\n--- one stretch, two people ---');
check('even split', computeDay(
  [{ person: A, startMinutes: hm(17, 30), endMinutes: hm(21) },
   { person: B, startMinutes: hm(17, 30), endMinutes: hm(21) }],
  [{ minutes: hm(19), cents: 6000 }], 0).totals,
  { [A]: 3000, [B]: 3000 });

console.log('\n--- a missing stretch shows up as unassigned money ---');
const gap = computeDay(
  [{ person: A, startMinutes: hm(17), endMinutes: hm(21) }],
  [
    { minutes: hm(12), cents: 2500 },
    { minutes: hm(19), cents: 1000 },
  ], 0);
check('morning tips are not silently absorbed', gap.unassigned.length, 1);
check('and not paid to the wrong person', gap.totals, { [A]: 1000 });

console.log('\n--- overlaps are derived, not reported ---');
// A works 2:00-5:45, B arrives 5:40, C arrives 5:45. Nobody coordinated.
const derived = buildStretches([
  { person: A, startMinutes: hm(14), endMinutes: hm(17, 45) },
  { person: B, startMinutes: hm(17, 40), endMinutes: hm(21) },
  { person: C, startMinutes: hm(17, 45), endMinutes: hm(21) },
]);
check('three stretches derived', derived.length, 3);
check('the 5-minute overlap is found', derived[1].people.sort(), [A, B]);
check('and the last crew is right', derived[2].people.sort(), [B, C]);

check('a gap nobody covered is dropped', buildStretches([
  { person: A, startMinutes: hm(11), endMinutes: hm(13) },
  { person: B, startMinutes: hm(17), endMinutes: hm(21) },
]).length, 2);

console.log('\n--- someone logging twice is caught ---');
check('duplicate found', findDuplicatePeople([
  { person: A, startMinutes: hm(14), endMinutes: hm(17) },
  { person: A, startMinutes: hm(14), endMinutes: hm(17) },
]), [A]);
check('two different people are fine', findDuplicatePeople([
  { person: A, startMinutes: hm(14), endMinutes: hm(17) },
  { person: B, startMinutes: hm(14), endMinutes: hm(17) },
]), []);

console.log('\n--- tips outside every stretch are never absorbed ---');
const stray = assignTips(
  [{ startMinutes: hm(17), endMinutes: hm(21), people: [A] }],
  [{ minutes: hm(9), cents: 500 }]);
check('early tip is set aside', stray.unassigned.length, 1);
check('and the pool stays empty', stray.pools[0].cents, 0);

console.log('\n--- the owner takes less than their share ---');
const after = applyOverrides({ [A]: 5000, [B]: 5000, [C]: 5000 }, { [A]: 2000 }, 0);
check('they keep 20.00', after[A], 2000);
check('total still reconciles', sumCents(after), 15000);

console.log('\n--- guardrails ---');
checkThrows('override cannot raise a share', () =>
  applyOverrides({ [A]: 5000, [B]: 5000 }, { [A]: 9000 }, 0));
checkThrows('stretch with nobody logged', () => splitPool(5000, [], 0));
checkThrows('negative pool', () => splitPool(-100, [A], 0));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
