import type { DomainConflict, DomainOperation, Occurrence, SeriesDefinition, SeriesSnapshot } from '../shared/models';
import { SCHEMA_VERSION } from '../shared/models';
import { compareIds, stableHash, stableStringify } from './identity';
import { validateRule } from './recurrence';
import { validateSchedule } from './dates';

const kinds = new Set(['CreateSeries','ReviseSeries','ResolveSeriesConflict','ActOccurrence','SetTaskFields','Advance','BindCarrier','ProjectionIntent','ProjectionReceipt','StopOrDelete','Restore','ObserveNative','RewindAdvance']);
function validateOperation(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['Operation is not an object'];
  const operation = value as DomainOperation;
  const errors: string[] = [];
  if (operation.schemaVersion !== SCHEMA_VERSION) errors.push('Unknown operation schema');
  if (typeof operation.opId !== 'string' || !operation.opId || typeof operation.seriesId !== 'string' || !operation.seriesId || typeof operation.deviceId !== 'string') errors.push('Invalid operation identity');
  if (!Number.isInteger(operation.deviceSeq) || operation.deviceSeq < 0 || !Number.isFinite(operation.recordedAt)) errors.push('Invalid operation audit header');
  if (!Array.isArray(operation.parents) || operation.parents.some(id => typeof id !== 'string' || !id || id === operation.opId)) errors.push('Invalid operation parents');
  if (!kinds.has(operation.kind)) errors.push('Unknown operation kind');
  try { if (operation.payloadHash !== stableHash(operation.payload)) errors.push('Operation payload hash mismatch'); } catch { errors.push('Invalid JSON payload'); }
  if (errors.length) return errors;
  try {
    const payload = operation.payload;
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');
    if (operation.kind === 'CreateSeries' || operation.kind === 'ReviseSeries' || operation.kind === 'ResolveSeriesConflict') {
      const d = operation.payload.definition;
      if (!d || d.seriesId !== operation.seriesId || d.revisionId !== operation.opId || !Array.isArray(d.parentRevisionIds)) throw new Error('Invalid series definition identity');
      errors.push(...validateRule(d.rule), ...validateSchedule(d.anchor));
      if (!['continuous','archive'].includes(d.modeForNext) || !['high','medium','low','none'].includes(d.priority)) errors.push('Invalid series fields');
      if (operation.kind === 'CreateSeries' && (!operation.payload.first?.occurrenceId || operation.payload.first.seriesId !== d.seriesId)) errors.push('Invalid first occurrence');
    } else if (operation.kind === 'SetTaskFields') {
      if (operation.payload.title !== undefined && (typeof operation.payload.title !== 'string' || !operation.payload.title.trim())) errors.push('Invalid series title');
    } else if (operation.kind === 'ActOccurrence') {
      const p = operation.payload;
      if (!p.occurrenceId || !['complete','skip','reopen','defer','snooze','deleteHistory'].includes(p.action)) errors.push('Invalid occurrence action');
      if ((p.action === 'complete' || p.action === 'skip') && !Number.isFinite(p.at)) errors.push('Invalid resolution instant');
      if (p.action === 'reopen' && !p.targetOpId) errors.push('Reopen must identify its resolution');
      if (p.action === 'defer') errors.push(...validateSchedule(p.schedule));
      if (p.action === 'snooze' && p.until !== null && !Number.isFinite(p.until)) errors.push('Invalid reminder instant');
    } else if (operation.kind === 'Advance') {
      const p = operation.payload;
      if (!p.predecessorId || !p.terminalOpId || !p.ruleRevisionId) errors.push('Invalid advancement edge');
      if (p.next && (p.next.predecessorId !== p.predecessorId || p.next.seriesId !== operation.seriesId)) errors.push('Invalid successor');
    } else if (operation.kind === 'RewindAdvance') {
      if (!operation.payload.occurrenceId || !operation.payload.targetOpId) errors.push('Rewind requires a resolution');
      if (!Array.isArray(operation.payload.targetOpIds) || !operation.payload.targetOpIds.length || operation.payload.targetOpIds.some(id => typeof id !== 'string')) errors.push('Invalid rewind targets');
    } else if (operation.kind === 'BindCarrier') {
      if (!operation.payload.occurrenceId || !operation.payload.noteId || !Number.isInteger(operation.payload.generation)) errors.push('Invalid carrier binding');
    } else if (operation.kind === 'ProjectionIntent' || operation.kind === 'ProjectionReceipt') {
      const p = operation.payload;
      if (!p.intentId || !p.noteId || !p.occurrenceId || !p.before || !p.after || !p.sourceOpId) errors.push('Invalid projection');
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}
export interface ReduceOptions { availableTemplateIds?: ReadonlySet<string> | readonly string[] }
export function reduceSeries(input: readonly DomainOperation[], options: ReduceOptions = {}): SeriesSnapshot {
  const conflicts: DomainConflict[] = [], byId = new Map<string, DomainOperation>();
  const conflict = (code: DomainConflict['code'], message: string, opIds: string[]) => conflicts.push({ code, message, opIds: [...opIds].sort() });
  for (const op of input) {
    const errors = validateOperation(op);
    if (errors.length) { conflict('invalid-operation', errors.join('; '), [op?.opId ?? 'unknown']); continue; }
    const existing = byId.get(op.opId);
    if (existing && stableStringify(existing) !== stableStringify(op)) conflict('duplicate-operation', 'Same operation ID has different content', [op.opId]);
    else byId.set(op.opId, op);
  }
  const operations = [...byId.values()].sort((a,b) => compareIds(a.opId, b.opId));
  const seriesId = operations[0]?.seriesId ?? '';
  if (operations.some(op => op.seriesId !== seriesId)) conflict('invalid-operation', 'Operations belong to different series', operations.map(op => op.opId));
  for (const op of operations) for (const parent of op.parents) if (!byId.has(parent)) conflict('missing-parent', `Waiting for operation ${parent}`, [op.opId, parent]);
  const remaining = new Map(byId), ordered: DomainOperation[] = [], emitted = new Set<string>();
  while (remaining.size) {
    const ready = [...remaining.values()].filter(op => op.parents.every(parent => emitted.has(parent))).sort((a,b) => compareIds(a.opId, b.opId));
    if (!ready.length) break;
    for (const op of ready) { ordered.push(op); emitted.add(op.opId); remaining.delete(op.opId); }
  }
  if (remaining.size && !conflicts.some(c => c.code === 'missing-parent')) conflict('cycle', 'Operation dependencies contain a cycle', [...remaining.keys()]);
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    const cached = ancestry.get(id); if (cached) return cached;
    const result = new Set<string>(), stack = [...(byId.get(id)?.parents ?? [])];
    while (stack.length) { const current = stack.pop()!; if (result.has(current)) continue; result.add(current); stack.push(...(byId.get(current)?.parents ?? [])); }
    ancestry.set(id, result); return result;
  };
  const precedes = (a: string, b: string) => ancestors(b).has(a);
  const heads = <T extends DomainOperation>(list: T[]): T[] => list.filter(a => !list.some(b => a !== b && precedes(a.opId, b.opId)));
  const definitions = ordered.filter((op): op is Extract<DomainOperation, { kind: 'CreateSeries' | 'ReviseSeries' | 'ResolveSeriesConflict' }> => ['CreateSeries','ReviseSeries','ResolveSeriesConflict'].includes(op.kind));
  // Revision ancestry is explicit: unrelated edits do not become a winner just because their clocks differ.
  const revisionById = new Map(definitions.map(op => [op.payload.definition.revisionId, op]));
  const superseded = new Set(definitions.flatMap(op => op.kind === 'ResolveSeriesConflict' ? [...op.payload.definition.parentRevisionIds, ...op.payload.resolvedRevisionIds] : op.payload.definition.parentRevisionIds));
  for (const op of definitions) for (const parent of op.payload.definition.parentRevisionIds) if (!revisionById.has(parent)) conflict('missing-parent', `Waiting for rule revision ${parent}`, [op.opId,parent]);
  const revisionHeads = definitions.filter(op => !superseded.has(op.payload.definition.revisionId));
  if (revisionHeads.length > 1) conflict('series-definition', 'Concurrent series or template revisions require resolution', revisionHeads.map(op => op.opId));
  const definition: SeriesDefinition | undefined = revisionHeads[0]?.payload.definition;
  const occurrences: Record<string, Occurrence> = {}, bindings: Record<string, string[]> = {}, advances: SeriesSnapshot['advances'] = {};
  const create = definitions.filter((op): op is Extract<DomainOperation, {kind:'CreateSeries'}> => op.kind === 'CreateSeries');
  for (const op of create) {
    const first = op.payload.first, old = occurrences[first.occurrenceId];
    if (old && stableStringify(old) !== stableStringify(first)) conflict('series-definition', 'Conflicting initial occurrence', create.map(row => row.opId));
    else occurrences[first.occurrenceId] = structuredCopy(first);
  }
  const advanceOps = ordered.filter((op): op is Extract<DomainOperation, {kind:'Advance'}> => op.kind === 'Advance').filter(op => {
    const terminal = byId.get(op.payload.terminalOpId);
    if (!terminal) { conflict('missing-parent', 'Waiting for advancement resolution operation', [op.opId, op.payload.terminalOpId]); return false; }
    if (terminal.kind !== 'ActOccurrence' || !['complete','skip'].includes(terminal.payload.action) || terminal.payload.occurrenceId !== op.payload.predecessorId || !precedes(terminal.opId, op.opId)) {
      conflict('invalid-operation', 'Advance must causally observe a completion or skip of its predecessor', [op.opId,terminal.opId]); return false;
    }
    if (!revisionById.has(op.payload.ruleRevisionId) || !precedes(op.payload.ruleRevisionId, op.opId)) { conflict('missing-parent', 'Waiting for the advancement rule revision', [op.opId,op.payload.ruleRevisionId]); return false; }
    return true;
  });
  const rewound = new Set(ordered.filter((op): op is Extract<DomainOperation, {kind:'RewindAdvance'}> => op.kind === 'RewindAdvance').flatMap(op => op.payload.targetOpIds.filter(id => {
    const target = byId.get(id);
    if (!target || target.kind !== 'Advance' || !precedes(id, op.opId)) { conflict('advance', 'Rewind must observe its advancement', [op.opId, id]); return false; }
    const terminal = byId.get(op.payload.targetOpId);
    if (!terminal || terminal.kind !== 'ActOccurrence' || !['complete', 'skip'].includes(terminal.payload.action) || terminal.payload.occurrenceId !== op.payload.occurrenceId || target.payload.predecessorId !== op.payload.occurrenceId || !precedes(terminal.opId, op.opId)) { conflict('advance', 'Rewind resolution does not match its predecessor', [op.opId]); return false; }
    const child = target.payload.next?.occurrenceId;
    if (child && advanceOps.some(edge => edge.payload.predecessorId === child && !precedes(op.opId, edge.opId) && !ordered.some(undo => undo.kind === 'RewindAdvance' && undo.payload.targetOpIds.includes(edge.opId) && precedes(undo.opId, op.opId)))) { conflict('advance', 'Successor advanced while its predecessor was being reopened', [op.opId]); }
    return true;
  })));
  // Keep withdrawn carriers associated with their series, including across reloads.
  for (const op of advanceOps) if (op.payload.next) occurrences[op.payload.next.occurrenceId] = structuredCopy(op.payload.next);
  const liveAdvanceOps = advanceOps.filter(op => !rewound.has(op.opId));
  for (const predecessor of [...new Set(liveAdvanceOps.map(op => op.payload.predecessorId))].sort()) {
    const group = heads(liveAdvanceOps.filter(op => op.payload.predecessorId === predecessor)).sort((a,b) => compareIds(a.opId, b.opId));
    const semantic = (op: typeof group[number]) => ({ next: op.payload.next ? { ...op.payload.next, carrierNoteId: '', carrierGeneration: 0 } : null, ruleRevisionId: op.payload.ruleRevisionId, templateRevisionId: op.payload.templateRevisionId, templateSourceNoteId: op.payload.templateSourceNoteId, templateContentHash: op.payload.templateContentHash });
    if (group.some(op => stableStringify(semantic(op)) !== stableStringify(semantic(group[0]!)))) conflict('advance', 'Concurrent advancement schedules or templates differ', group.map(op => op.opId));
    const selected = group[0]!; advances[predecessor] = structuredCopy(selected.payload);
    if (selected.payload.next) occurrences[selected.payload.next.occurrenceId] = structuredCopy(selected.payload.next);
  }
  // Only live advancement edges consume a period; earlier history edits keep their edges.
  for (const predecessor of Object.keys(advances)) {
    if (occurrences[predecessor]) occurrences[predecessor]!.consumed = true;
    else conflict('missing-parent', `Missing predecessor ${predecessor}`, advanceOps.filter(op => op.payload.predecessorId === predecessor).map(op => op.opId));
  }
  for (const occurrence of Object.values(occurrences)) {
    const actions = ordered.filter((op): op is Extract<DomainOperation, {kind:'ActOccurrence'}> => op.kind === 'ActOccurrence' && op.payload.occurrenceId === occurrence.occurrenceId);
    occurrence.historyDeleted = actions.some(op => op.payload.action === 'deleteHistory');
    const terminals = actions.filter(op => op.payload.action === 'complete' || op.payload.action === 'skip');
    const reopened = new Set(actions.filter(op => op.payload.action === 'reopen').flatMap(op => op.payload.action === 'reopen' && precedes(op.payload.targetOpId, op.opId) ? [op.payload.targetOpId] : []));
    for (const op of ordered) if (op.kind === 'RewindAdvance' && op.payload.occurrenceId === occurrence.occurrenceId && precedes(op.payload.targetOpId, op.opId) &&
      !liveAdvanceOps.some(edge => edge.payload.predecessorId === occurrence.occurrenceId && edge.payload.terminalOpId === op.payload.targetOpId)) reopened.add(op.payload.targetOpId);
    const live = heads(terminals).filter(op => !reopened.has(op.opId)).sort((a,b) => {
      const aRank = a.payload.action === 'complete' ? 0 : 1, bRank = b.payload.action === 'complete' ? 0 : 1;
      return aRank - bRank || compareIds(a.opId, b.opId);
    });
    if (live.length) {
      const terminal = live[0]!;
      occurrence.resolution = terminal.payload.action === 'complete' ? 'completed' : 'skipped';
      occurrence.resolvedAt = 'at' in terminal.payload ? terminal.payload.at : undefined;
      occurrence.terminalOpId = terminal.opId;
    } else { occurrence.resolution = 'open'; delete occurrence.resolvedAt; delete occurrence.terminalOpId; }
    const defers = heads(actions.filter(op => op.payload.action === 'defer')).sort((a,b) => compareIds(a.opId, b.opId));
    const defer = defers[0]; if (defer?.payload.action === 'defer') occurrence.deferred = structuredCopy(defer.payload.schedule);
    const snoozes = heads(actions.filter(op => op.payload.action === 'snooze')).sort((a,b) => compareIds(a.opId, b.opId));
    const snooze = snoozes[0]; if (snooze?.payload.action === 'snooze') occurrence.reminderOverride = snooze.payload.until ?? undefined;
    // Replay all causally applicable schedule revisions, including for consumed history.
    // Later edits of another field must not erase the schedule used when this period resolved.
    const scheduleEdits = definitions.filter((op): op is Extract<DomainOperation, {kind:'ReviseSeries'|'ResolveSeriesConflict'}> =>
      op.kind !== 'CreateSeries' && op.payload.current?.occurrenceId === occurrence.occurrenceId &&
      (!occurrence.terminalOpId || precedes(op.opId, occurrence.terminalOpId)));
    const scheduleHeads = heads(scheduleEdits);
    if (scheduleHeads.length > 1) conflict('series-definition', 'Concurrent period schedules require resolution', scheduleHeads.map(op => op.opId));
    const edit = scheduleHeads.sort((a,b) => compareIds(a.opId,b.opId))[0];
    if (edit?.payload.current) {
      const patch = edit.payload.current;
      occurrence.suppressedSlotKeys = [...new Set([...occurrence.suppressedSlotKeys, occurrence.originSlotKey, patch.slotKey])];
      occurrence.scheduled = structuredCopy(patch.schedule);
      occurrence.originSlotKey = patch.slotKey;
      occurrence.originatingRevisionId = edit.opId;
      if (patch.clearDeferred && (!defer || precedes(defer.opId, edit.opId))) delete occurrence.deferred;
    }
    const bindingOps = ordered.filter((op): op is Extract<DomainOperation,{kind:'BindCarrier'}> => op.kind === 'BindCarrier' && op.payload.occurrenceId === occurrence.occurrenceId &&
      (op.payload.noteId === occurrence.carrierNoteId || !advanceOps.some(edge => rewound.has(edge.opId) && edge.payload.next?.occurrenceId === occurrence.occurrenceId && edge.payload.next.carrierNoteId === op.payload.noteId)) && (op.payload.noteId === occurrence.carrierNoteId || !advanceOps.some(edge => edge.payload.next?.occurrenceId === occurrence.occurrenceId && edge.payload.next.carrierNoteId === occurrence.carrierNoteId && precedes(op.opId, edge.opId)))).sort((a,b) => compareIds(a.opId, b.opId));
    bindings[occurrence.occurrenceId] = [...new Set([occurrence.carrierNoteId, ...bindingOps.map(op => op.payload.noteId)].filter(Boolean))].sort();
    if (bindingOps[0]) { occurrence.carrierNoteId = bindingOps[0].payload.noteId; occurrence.carrierGeneration = bindingOps[0].payload.generation; }
  }
  let activeOccurrenceId: string | undefined = create[0]?.payload.first.occurrenceId;
  const visited = new Set<string>();
  while (activeOccurrenceId && advances[activeOccurrenceId]) {
    if (visited.has(activeOccurrenceId)) { conflict('cycle','Advancement chain contains a cycle', []); break; }
    visited.add(activeOccurrenceId); activeOccurrenceId = advances[activeOccurrenceId]!.next?.occurrenceId;
  }
  const reachable = new Set<string>();
  let cursor: string | undefined = create[0]?.payload.first.occurrenceId;
  while (cursor && !reachable.has(cursor)) { reachable.add(cursor); cursor = advances[cursor]?.next?.occurrenceId; }
  for (const occurrence of Object.values(occurrences)) occurrence.withdrawn = !reachable.has(occurrence.occurrenceId);
  if (definition) {
    // Pins belong to an occurrence, including legacy edits without an explicit ID.
    for (const occurrence of Object.values(occurrences)) {
      const pins = ordered.filter((op): op is Extract<DomainOperation, {kind:'SetTaskFields'}> => {
        if (op.kind !== 'SetTaskFields' || op.payload.pinned === undefined) return false;
        if (op.payload.occurrenceId) return op.payload.occurrenceId === occurrence.occurrenceId;
        let target: string | undefined = create[0]?.payload.first.occurrenceId;
        while (target && advances[target]) {
          const advance = advanceOps.find(row => row.payload.predecessorId === target && precedes(row.opId, op.opId));
          if (!advance) break;
          target = advance.payload.next?.occurrenceId;
        }
        return target === occurrence.occurrenceId;
      });
      const pin = heads(pins).sort((a,b) => compareIds(a.opId, b.opId))[0];
      const resolved = ordered.filter(op => op.kind === 'ActOccurrence' && op.payload.occurrenceId === occurrence.occurrenceId && ['complete', 'skip'].includes(op.payload.action));
      const initialPin = create.some(op => op.payload.first.occurrenceId === occurrence.occurrenceId && op.payload.definition.pinned);
      occurrence.pinned = occurrence.resolution === 'open' && (pin ? !!pin.payload.pinned && resolved.every(op => precedes(op.opId, pin.opId)) : initialPin && !resolved.length);
    }
    const fieldOps = ordered.filter((op): op is Extract<DomainOperation,{kind:'SetTaskFields'}> => op.kind === 'SetTaskFields');
    // Copy before applying simple display fields; never mutate an operation supplied by a repository.
    const displayDefinition = structuredCopy(definition);
    let titleOperationId: string | undefined;
    for (const field of ['title','priority','pinned'] as const) { const applicable = heads(fieldOps.filter(op => op.payload[field] !== undefined)).sort((a,b)=>compareIds(a.opId, b.opId))[0]; if (applicable) { Object.assign(displayDefinition, { [field]: applicable.payload[field] }); if (field === 'title') titleOperationId = applicable.opId; } }
    if (options.availableTemplateIds && displayDefinition.templateRevisionId && !new Set(options.availableTemplateIds).has(displayDefinition.templateRevisionId)) conflict('missing-template', 'Waiting for template revision', [displayDefinition.templateRevisionId]);
    const restored = new Set(ordered.filter((op):op is Extract<DomainOperation,{kind:'Restore'}>=>op.kind==='Restore').flatMap(op=>op.payload.targetOpIds.filter(id=>precedes(id,op.opId))));
    const stops = ordered.filter((op):op is Extract<DomainOperation,{kind:'StopOrDelete'}>=>op.kind==='StopOrDelete'&&!restored.has(op.opId));
    const status: SeriesSnapshot['status'] = conflicts.length ? (conflicts.every(c=>['missing-parent','missing-template'].includes(c.code)) ? 'waiting':'pausedConflict') : (!activeOccurrenceId || stops.length > 0 ? 'ended':'active');
    const projections = ordered.filter((op): op is Extract<DomainOperation,{kind:'ProjectionIntent'|'ProjectionReceipt'}>=>op.kind==='ProjectionIntent'||op.kind==='ProjectionReceipt').map(op=>structuredCopy(op.payload));
    return { seriesId, titleOperationId, definition: displayDefinition, revisionHeads:revisionHeads.map(op=>op.opId).sort(), operationHeads:heads(ordered).map(op=>op.opId).sort(), occurrences, activeOccurrenceId, consumedCount:[...reachable].filter(id => !!advances[id]).length, advances,bindings, projections,conflicts,status,operations };
  }
  return { seriesId, revisionHeads:[],operationHeads:heads(ordered).map(op=>op.opId).sort(),occurrences,activeOccurrenceId,consumedCount:[...reachable].filter(id => !!advances[id]).length,advances,bindings,projections:[],conflicts:[...conflicts,{code:'missing-parent',message:'Waiting for series definition',opIds:[]}],status:'waiting',operations };
}
function structuredCopy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function canAdvance(snapshot: SeriesSnapshot, occurrenceId: string): boolean {
  const occurrence = snapshot.occurrences[occurrenceId];
  return snapshot.status === 'active' && snapshot.activeOccurrenceId === occurrenceId && !!occurrence && !occurrence.consumed && occurrence.resolution !== 'open';
}
