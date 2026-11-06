import type { AdvancePayload, CalendarContext, DatedSchedule, Occurrence, OccurrenceAction, SeriesDefinition, SeriesSnapshot } from '../shared/models';
import { scheduleForDate, scheduleInstant, validateSchedule } from './dates';
import { candidateNoteId, candidateSlotKey, occurrenceKey } from './identity';
import { nextCandidate } from './recurrence';
import { canAdvance } from './series';

function current(snapshot: SeriesSnapshot, id?: string): Occurrence {
  const occurrenceId = id ?? snapshot.activeOccurrenceId;
  const occurrence = occurrenceId ? snapshot.occurrences[occurrenceId] : undefined;
  if (!occurrence || snapshot.status !== 'active' || !snapshot.definition) throw new Error('Series is unavailable, paused or ended');
  return occurrence;
}
export function undoOccurrence(snapshot: SeriesSnapshot, occurrenceId: string): OccurrenceAction {
  const occurrence = snapshot.occurrences[occurrenceId];
  if (!occurrence?.terminalOpId || occurrence.resolution === 'open') throw new Error('Occurrence has no resolution to undo');
  if (snapshot.conflicts.length) throw new Error('Resolve the series conflict before undo');
  return { action: 'reopen', occurrenceId, targetOpId: occurrence.terminalOpId };
}
export function snoozeCurrent(snapshot: SeriesSnapshot, until: number, now: number): OccurrenceAction {
  const occurrence = current(snapshot);
  if (occurrence.resolution !== 'open' || !Number.isFinite(until) || until <= now) throw new Error('Reminder must be later than now');
  return { action: 'snooze', occurrenceId: occurrence.occurrenceId, until };
}
/** Rules affect future periods; only an explicit date edit moves the current period. */
export function ruleRevisionSchedule(calendar: CalendarContext, requested?: DatedSchedule): DatedSchedule | undefined {
  if (!requested) return undefined;
  const errors = validateSchedule(requested, calendar);
  if (errors.length) throw new Error(errors.join('; '));
  return { ...requested };
}

/** One cursor policy for execution, calendar forecasts and the series editor. */
export function nextPeriodBasis(definition: SeriesDefinition, planned: DatedSchedule, at: number, calendar: CalendarContext): { definition: SeriesDefinition; after: number } {
  if (definition.rule.basis === 'scheduled') return { definition, after: scheduleInstant(planned, calendar.zone) };
  const date = calendar.zone.localDate(at, definition.anchor.zone);
  const anchor = scheduleForDate(definition.anchor, date, calendar);
  return { definition: { ...definition, anchor }, after: Math.max(at, scheduleInstant(anchor, calendar.zone)) };
}
export function nextPeriodCandidate(definition: SeriesDefinition, planned: DatedSchedule, at: number, calendar: CalendarContext, consumedCount: number) {
  const basis = nextPeriodBasis(definition, planned, at, calendar);
  return nextCandidate(basis.definition, basis.after, calendar, consumedCount);
}
/** Recalculate an open period, or continue an ended series, using the same basis as normal advancement. */
export function revisedPeriodCandidate(definition: SeriesDefinition, history: readonly Pick<Occurrence, 'scheduled' | 'resolvedAt'>[], calendar: CalendarContext, consumedCount: number) {
  if (definition.rule.basis === 'completed' && history.length) {
    const previous = history[history.length - 1]!;
    const basis = nextPeriodBasis(definition, previous.scheduled, previous.resolvedAt ?? scheduleInstant(previous.scheduled, calendar.zone), calendar);
    return nextCandidate(basis.definition, Math.max(basis.after, scheduleInstant(definition.anchor, calendar.zone) - 1), calendar, consumedCount);
  }
  // Exclude every historical calendar date, including when the anchor clock changes.
  const after = Math.max(scheduleInstant(definition.anchor, calendar.zone) - 1,
    ...history.map(row => scheduleInstant(scheduleForDate(definition.anchor, row.scheduled.date, calendar), calendar.zone)));
  return nextCandidate(definition, after, calendar, consumedCount);
}
export function planAdvance(snapshot: SeriesSnapshot, at: number, calendar: CalendarContext, creatingOpId: string, schedule?: DatedSchedule): AdvancePayload {
  const occurrence = current(snapshot);
  if (!canAdvance(snapshot, occurrence.occurrenceId) || !occurrence.terminalOpId) throw new Error('Only an unconsumed resolved active occurrence may advance');
  const definition = snapshot.definition!;
  const candidate = schedule ? { schedule }
    : nextPeriodCandidate(definition, occurrence.scheduled, occurrence.resolvedAt ?? at, calendar, snapshot.consumedCount + 1);
  const base: AdvancePayload = { predecessorId: occurrence.occurrenceId, terminalOpId: occurrence.terminalOpId, next: null, ruleRevisionId: definition.revisionId };
  if (!candidate) return base;
  const id = occurrenceKey(snapshot.seriesId, occurrence.occurrenceId);
  // Continuous mode always advances the existing execution note. Archive reads its
  // native source at execution time; no serialized template revision is required.
  const createsCarrier = definition.modeForNext === 'archive';
  const noteId = createsCarrier ? candidateNoteId(id, creatingOpId) : occurrence.carrierNoteId;
  const next: Occurrence = {
    occurrenceId: id, seriesId: snapshot.seriesId, predecessorId: occurrence.occurrenceId,
    originatingRevisionId: definition.revisionId, originSlotKey: candidateSlotKey(definition, candidate.schedule), suppressedSlotKeys: [],
    scheduled: candidate.schedule, resolution: 'open', consumed: false, carrierNoteId: noteId,
    carrierGeneration: occurrence.carrierGeneration + 1, mode: definition.modeForNext,
  };
  return { ...base, next, ...(createsCarrier ? { candidateNoteId: noteId } : {}), omittedFrom: occurrence.scheduled.date, omittedUntil: candidate.schedule.date };
}
