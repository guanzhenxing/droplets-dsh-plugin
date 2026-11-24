import test from 'node:test';
import assert from 'node:assert/strict';

const { planTicks, visibleActiveIndex, PITCH_NORMAL } = await import('../src/client/feed/tick-plan.js');

test('few headings keep every tick at the comfortable rhythm', () => {
  const outline = [
    { level: 2, text: 'a' }, { level: 3, text: 'a1' }, { level: 3, text: 'a2' },
    { level: 2, text: 'b' }, { level: 3, text: 'b1' },
  ];
  const plan = planTicks(outline, 600);
  assert.equal(plan.items.length, 5);
  assert.equal(plan.tickH, 12);
  assert.equal(plan.gap, 3);
  assert.equal(plan.filtered, false);
});

test('the 45-entry work log collapses to its 17 date ticks instead of overflowing', () => {
  // Interleaved like a real log: each date followed by its sections.
  const mixed = [];
  for (let i = 0; i < 17; i += 1) {
    mixed.push({ level: 3, text: `date ${i}` });
    if (i < 11) mixed.push({ level: 4, text: `sec ${i}.0` }, { level: 4, text: `sec ${i}.1` });
    if (i < 6) mixed.push({ level: 4, text: `sec ${i}.2` });
  }
  // 17 dates + 28 sections = 45 headings; the 15px rhythm needs 675px.
  const budget = 464; // a realistic reader pane after chrome
  const plan = planTicks(mixed, budget);
  assert.ok(mixed.length * PITCH_NORMAL > budget, 'precondition: would overflow');
  assert.equal(plan.filtered, true, 'deep levels dropped');
  assert.ok(plan.items.every((item) => item.level === 3), 'only date-level ticks remain');
  assert.ok(plan.items.length * (plan.tickH + plan.gap) <= budget + PITCH_NORMAL, 'fits the budget');
  // Original indices survive so jump/active stay aligned.
  assert.deepEqual(plan.items.map((item) => mixed[item.index].text).slice(0, 3), ['date 0', 'date 1', 'date 2']);
  assert.equal(plan.total, mixed.length);
});

test('a single-level outline squeezes its rhythm instead of dropping anything', () => {
  const flat = Array.from({ length: 40 }, (_, i) => ({ level: 2, text: `h2 ${i}` }));
  const plan = planTicks(flat, 300);
  assert.equal(plan.filtered, false, 'nothing to drop at one level');
  assert.equal(plan.items.length, 40);
  assert.equal(plan.tickH, 6, 'compressed: 300/40 = 7px pitch minus the 1px gap');
  assert.equal(plan.gap, 1);
  assert.ok(40 * (plan.tickH + plan.gap) <= 300);
});

test('degenerate inputs: empty outline and zero budget', () => {
  assert.deepEqual(planTicks([], 500), { items: [], tickH: 12, gap: 3, filtered: false, total: 0 });
  const plan = planTicks([{ level: 2, text: 'x' }], 0);
  assert.equal(plan.items.length, 0);
});

test('visibleActiveIndex maps a deep active heading to its visible ancestor', () => {
  const items = [{ index: 0 }, { index: 5 }, { index: 10 }];
  assert.equal(visibleActiveIndex(items, 7), 5, 'inside a section → the enclosing date tick');
  assert.equal(visibleActiveIndex(items, 5), 5, 'exactly on a visible tick');
  assert.equal(visibleActiveIndex(items, 0), 0);
  assert.equal(visibleActiveIndex(items, -1), -1);
  assert.equal(visibleActiveIndex([], 3), -1);
  // Unfiltered plans keep exact matching (items are 0..n-1 in order).
  const all = [{ index: 0 }, { index: 1 }, { index: 2 }];
  assert.equal(visibleActiveIndex(all, 2), 2);
});
