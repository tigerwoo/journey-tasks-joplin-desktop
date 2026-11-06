import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceSeries } from '../../src/domain/series';
import { initialSeries, nextOccurrence, operation } from '../fixtures/operations';
import type { DomainOperation } from '../../src/shared/models';

test('unresolved current cycle does not advance simply because operations are replayed', () => {
  const { create, first } = initialSeries();
  const snapshot = reduceSeries([create, create]);
  assert.equal(snapshot.activeOccurrenceId, first.occurrenceId);
  assert.equal(snapshot.consumedCount, 0);
  assert.equal(Object.keys(snapshot.occurrences).length, 1);
  assert.equal(Object.keys(snapshot.advances).length, 0);
});

test('complete then advance consumes once under reversed, duplicate and repeated input', () => {
  const { create, first, def } = initialSeries();
  const done = operation('done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 1706700000000 });
  const next = nextOccurrence(first, def);
  const advance = operation('advance', 'Advance', { predecessorId: first.occurrenceId,
    terminalOpId: done.opId, next, ruleRevisionId: def.revisionId }, [done.opId]);
  const normal = reduceSeries([create, done, advance]);
  const reordered = reduceSeries([advance, done, create, done, advance]);
  assert.equal(normal.consumedCount, 1);
  assert.equal(normal.activeOccurrenceId, next.occurrenceId);
  assert.equal(normal.occurrences[first.occurrenceId]!.consumed, true);
  assert.deepEqual(reordered, normal);
});

test('skip is not complete, but an explicit advance creates the next active cycle', () => {
  const { create, first, def } = initialSeries();
  const skip = operation('skip', 'ActOccurrence', { action: 'skip', occurrenceId: first.occurrenceId, at: 1706700000000 });
  const next = nextOccurrence(first, def);
  const advance = operation('advance', 'Advance', { predecessorId: first.occurrenceId,
    terminalOpId: skip.opId, next, ruleRevisionId: def.revisionId }, [skip.opId]);
  const snapshot = reduceSeries([advance, create, skip]);
  assert.equal(snapshot.occurrences[first.occurrenceId]!.resolution, 'skipped');
  assert.equal(snapshot.activeOccurrenceId, next.occurrenceId);
  assert.equal(snapshot.consumedCount, 1);
});

test('reopening and recompleting an already advanced old cycle cannot consume twice or delete successor', () => {
  const { create, first, def } = initialSeries();
  const done = operation('done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 1706700000000 });
  const next = nextOccurrence(first, def);
  const advance = operation('advance', 'Advance', { predecessorId: first.occurrenceId,
    terminalOpId: done.opId, next, ruleRevisionId: def.revisionId }, [done.opId]);
  const reopen = operation('reopen', 'ActOccurrence', { action: 'reopen', occurrenceId: first.occurrenceId, targetOpId: done.opId }, [advance.opId]);
  const reopened = reduceSeries([create, done, advance, reopen]);
  assert.equal(reopened.occurrences[first.occurrenceId]!.resolution, 'open');
  assert.equal(reopened.occurrences[first.occurrenceId]!.consumed, true);
  assert.equal(reopened.activeOccurrenceId, next.occurrenceId);
  const again = operation('again', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 1706800000000 }, [reopen.opId]);
  const repeated = reduceSeries([again, advance, done, create, reopen]);
  assert.equal(repeated.consumedCount, 1);
  assert.equal(repeated.activeOccurrenceId, next.occurrenceId);
  assert.equal(Object.keys(repeated.occurrences).length, 2);
});

test('temporary defer/snooze preserves original anchor, cycle identity and consumed count', () => {
  const { create, first, def } = initialSeries();
  const deferred = { ...first.scheduled, date: '2024-02-03' };
  const defer = operation('defer', 'ActOccurrence', { action: 'defer', occurrenceId: first.occurrenceId, schedule: deferred });
  const snooze = operation('snooze', 'ActOccurrence', { action: 'snooze', occurrenceId: first.occurrenceId, until: 1707000000000 }, [defer.opId]);
  const snapshot = reduceSeries([snooze, create, defer]);
  assert.deepEqual(snapshot.definition!.anchor, def.anchor);
  assert.deepEqual(snapshot.occurrences[first.occurrenceId]!.scheduled, first.scheduled);
  assert.deepEqual(snapshot.occurrences[first.occurrenceId]!.deferred, deferred);
  assert.equal(snapshot.activeOccurrenceId, first.occurrenceId);
  assert.equal(snapshot.consumedCount, 0);
});

test('missing causal parent fails closed rather than exposing an actionable partial series', () => {
  const { create, first } = initialSeries();
  const done = operation('done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 100 }, ['missing']);
  const snapshot = reduceSeries([create, done]);
  assert.notEqual(snapshot.status, 'active');
  assert.ok(snapshot.conflicts.some(conflict => conflict.code === 'missing-parent'));
});

test('same operation ID with different payload is corruption, not last-write-wins', () => {
  const { create, first } = initialSeries();
  const one = operation('done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 100 });
  const two = operation('done', 'ActOccurrence', { action: 'skip', occurrenceId: first.occurrenceId, at: 100 });
  const snapshot = reduceSeries([create, one, two]);
  assert.equal(snapshot.status, 'pausedConflict');
  assert.ok(snapshot.conflicts.some(conflict => conflict.code === 'duplicate-operation'));
});

test('concurrent rule revisions are preserved and pause regardless of timestamp skew/order', () => {
  const { create, def } = initialSeries();
  const a = operation('A-revise', 'ReviseSeries', { definition: { ...def, revisionId: 'A-revise', parentRevisionIds: ['create'], priority: 'high' } }, ['create'], 999999999);
  const b = operation('B-revise', 'ReviseSeries', { definition: { ...def, revisionId: 'B-revise', parentRevisionIds: ['create'], priority: 'low' } }, ['create'], -999999999);
  const left = reduceSeries([create, a, b]);
  const right = reduceSeries([b, a, create]);
  assert.equal(left.status, 'pausedConflict');
  assert.deepEqual(new Set(left.revisionHeads), new Set(['A-revise', 'B-revise']));
  assert.deepEqual(right, left);
});

test('concurrent complete/skip keeps both intents, completion display wins deterministically', () => {
  const { create, first } = initialSeries();
  const done = operation('A-done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 100 });
  const skip = operation('B-skip', 'ActOccurrence', { action: 'skip', occurrenceId: first.occurrenceId, at: 200 });
  const left = reduceSeries([create, done, skip]);
  const right = reduceSeries([skip, create, done]);
  assert.equal(left.occurrences[first.occurrenceId]!.resolution, 'completed');
  assert.equal(left.operations.length, 3);
  assert.deepEqual(right, left);
});

test('hash tampering and cyclic dependencies do not become active state', () => {
  const { create, first } = initialSeries();
  const tampered = operation('bad', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 100 });
  tampered.payloadHash = 'not-the-payload-hash';
  assert.notEqual(reduceSeries([create, tampered]).status, 'active');
  const a = operation('A', 'SetTaskFields', { priority: 'high' }, ['B']);
  const b = operation('B', 'SetTaskFields', { priority: 'low' }, ['A']);
  const cyclic = reduceSeries([create, a, b] as DomainOperation[]);
  assert.notEqual(cyclic.status, 'active');
  assert.ok(cyclic.conflicts.some(conflict => conflict.code === 'cycle'));
});

test('causally later pinned-only edit cannot erase an earlier priority edit', () => {
  const { create } = initialSeries();
  const priority = operation('priority', 'SetTaskFields', { priority: 'high' });
  const pinned = operation('pinned', 'SetTaskFields', { pinned: true }, [priority.opId]);
  const snapshot = reduceSeries([pinned, create, priority]);
  assert.equal(snapshot.definition!.priority, 'high');
  assert.equal(snapshot.definition!.pinned, true);
});

test('advance without an observed valid terminal cannot silently consume an open cycle', () => {
  const { create, first, def } = initialSeries();
  const advance = operation('advance', 'Advance', { predecessorId: first.occurrenceId,
    terminalOpId: 'nonexistent-completion', next: nextOccurrence(first, def), ruleRevisionId: def.revisionId });
  const snapshot = reduceSeries([create, advance]);
  assert.notEqual(snapshot.status, 'active');
  assert.ok(snapshot.conflicts.length > 0);
});

test('legacy and occurrence-scoped pins do not leak across advancement or completion undo', () => {
  const { create, first, def } = initialSeries();
  const pin = operation('pin', 'SetTaskFields', { pinned: true });
  assert.equal(reduceSeries([pin, create]).occurrences[first.occurrenceId]?.pinned, true);
  const done = operation('done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 100 }, [pin.opId]);
  const next = nextOccurrence(first, def);
  const advance = operation('advance', 'Advance', { predecessorId: first.occurrenceId, terminalOpId: done.opId, next, ruleRevisionId: def.revisionId }, [done.opId]);
  const nextPin = operation('next-pin', 'SetTaskFields', { pinned: true }, [advance.opId]);
  const undo = operation('undo', 'ActOccurrence', { action: 'reopen', occurrenceId: first.occurrenceId, targetOpId: done.opId }, [nextPin.opId]);
  const operations = [create, pin, done, advance, nextPin, undo];
  const snapshot = reduceSeries(operations);
  assert.equal(snapshot.occurrences[first.occurrenceId]?.pinned, false);
  assert.equal(snapshot.occurrences[next.occurrenceId]?.pinned, true);
  assert.deepEqual(reduceSeries([...operations].reverse()), snapshot);
  const historyPin = operation('history-pin', 'SetTaskFields', { occurrenceId: first.occurrenceId, pinned: true }, [undo.opId]);
  const unpinNext = operation('unpin-next', 'SetTaskFields', { occurrenceId: next.occurrenceId, pinned: false }, [historyPin.opId]);
  const edited = reduceSeries([...operations, historyPin, unpinNext]);
  assert.equal(edited.occurrences[first.occurrenceId]?.pinned, true);
  assert.equal(edited.occurrences[next.occurrenceId]?.pinned, false);
});

for (const scope of ['current', 'series'] as const) test(`legacy ${scope} deletion logs load as ended and can resume from a rule save`, () => {
  const { create, first } = initialSeries();
  const stop = operation('old-delete', 'StopOrDelete', { scope, occurrenceId: first.occurrenceId });
  const ended = reduceSeries([create, stop]);
  assert.equal(ended.status, 'ended'); assert.deepEqual(ended.conflicts, []);
  const restore = operation('restore', 'Restore', { targetOpIds: [stop.opId] }, [stop.opId]);
  assert.equal(reduceSeries([create, stop, restore]).status, 'active');
});

test('legacy full advancement rewind still reopens its predecessor', () => {
  const { create, first, def } = initialSeries();
  const done = operation('done', 'ActOccurrence', { action: 'complete', occurrenceId: first.occurrenceId, at: 1706700000000 });
  const next = nextOccurrence(first, def);
  const advance = operation('advance', 'Advance', { predecessorId: first.occurrenceId, terminalOpId: done.opId, next, ruleRevisionId: def.revisionId }, [done.opId]);
  const rewind = operation('legacy-rewind', 'RewindAdvance', { targetOpIds: [advance.opId], occurrenceId: first.occurrenceId, targetOpId: done.opId }, [advance.opId]);
  const snapshot = reduceSeries([create, done, advance, rewind]);
  assert.equal(snapshot.status, 'active'); assert.equal(snapshot.activeOccurrenceId, first.occurrenceId);
  assert.equal(snapshot.occurrences[first.occurrenceId]!.resolution, 'open'); assert.equal(snapshot.consumedCount, 0);
  assert.equal(snapshot.occurrences[next.occurrenceId]!.withdrawn, true);
});
