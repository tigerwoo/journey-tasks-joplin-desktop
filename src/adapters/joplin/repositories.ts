import type { DomainOperation, Task, TemplateRevision, Schedule, Priority, ReminderPolicy } from '../../shared/models';
import { stableHash, stableStringify } from '../../domain/identity';
import { validateSchedule } from '../../domain/dates';
import { reduceSeries } from '../../domain/series';
import { JoplinGateway, NativeNote, StorageError } from './gateway';
import { UserDataStore } from './userDataStore';
import { LocalIntentStore } from './localIntentStore';
import { CURRENT_STORAGE_VERSION } from '../../shared/storageVersion';
import { PLUGIN_ID as DEFAULT_PLUGIN_ID } from '../../shared/pluginIdentity';

export { PLUGIN_ID as DEFAULT_PLUGIN_ID } from '../../shared/pluginIdentity';
const STORAGE_VERSION = CURRENT_STORAGE_VERSION;
const V3_PREFIXES = { scope: 'v3:scope:', operation: 'v3:op:', template: 'v2:template:', carrier: 'v3:carrier:', pending: 'v3:pending:' } as const;
function boundedKey(key: string): string {
  if (key.length > 255) throw new StorageError('STORAGE_KEY_LENGTH', '插件数据键超出宿主长度限制。');
  return key;
}
function requireId(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 160 || /[\s\u0000]/.test(value)) throw new StorageError('STORAGE_ID', '插件存储身份无效。');
  return value;
}
const encodedScope = (scopeId: string): string => encodeURIComponent(requireId(scopeId));
export const scopeKey = (scopeId: string): string => boundedKey(`${V3_PREFIXES.scope}${encodedScope(scopeId)}`);
export const operationPrefix = (scopeId: string): string => boundedKey(`${V3_PREFIXES.operation}${encodedScope(scopeId)}:`);
const operationKey = (scopeId: string, opId: string): string => boundedKey(`${operationPrefix(scopeId)}${requireId(opId)}`);
const carrierKey = (seriesId: string, occurrenceId: string): string => boundedKey(`${V3_PREFIXES.carrier}${encodedScope(seriesId)}:${encodeURIComponent(requireId(occurrenceId))}`);
const isCurrentStorageKey = (key: string): boolean => key.startsWith('v3:');

export interface ControlMeta {
  schemaVersion: 3;
  role: 'series' | 'single';
  seriesId: string;
  rootNoteId: string;
  anchorGeneration?: number;
  transferId?: string;
  ancestorNoteIds?: string[];
  stoppedSeriesId?: string;
}
interface AnchorCommit { schemaVersion: 3; seriesId: string; transferId: string; rootNoteId: string; ancestorNoteIds: string[]; operationHashes: Record<string, string> }
const commitKey = (seriesId: string, transferId: string): string => boundedKey(`v3:anchor-commit:${encodedScope(seriesId)}:${requireId(transferId)}`);

export interface CarrierSnapshot {
  schedule: Schedule;
  priority: Priority;
  pinned: boolean;
  reminder: ReminderPolicy;
  reminderOverride?: number;
  carrierGeneration?: number;
}
export interface CarrierMeta {
  schemaVersion: 3;
  role: 'carrier';
  seriesId: string;
  anchorNoteId: string;
  occurrenceId: string;
  creationHash: string;
  snapshot?: CarrierSnapshot;
}
export interface SingleOperation {
  schemaVersion: 1;
  opId: string;
  deviceId: string;
  deviceSeq: number;
  parents: string[];
  recordedAt: number;
  kind: 'SingleCreate' | 'SinglePatch' | 'SingleProjectionIntent' | 'SingleProjectionReceipt' | 'SingleObserve' | 'SingleDelete';
  payload: any;
  payloadHash: string;
}
export type JournalOperation = DomainOperation | SingleOperation;
const singleKinds = new Set(['SingleCreate', 'SinglePatch', 'SingleProjectionIntent', 'SingleProjectionReceipt', 'SingleObserve', 'SingleDelete']);
export interface DiscoveryIssue { noteId: string; rootNoteId?: string; seriesId?: string; message: string }
export interface DiscoveryResult {
  controls: Array<{ note: NativeNote; meta: ControlMeta }>;
  templates: TemplateRevision[];
  carriers: Array<{ note: NativeNote; meta: CarrierMeta }>;
  issues: DiscoveryIssue[];
}

function validateControlMeta(value: unknown, noteId: string): asserts value is ControlMeta {
  const meta = value as ControlMeta;
  if (!meta || meta.schemaVersion !== STORAGE_VERSION || !['single', 'series'].includes(meta.role) || !meta.seriesId || meta.rootNoteId !== noteId)
    throw new StorageError('INVALID_CONTROL', '任务自身存储身份或版本无效。', { noteId });
  requireId(meta.seriesId); requireId(meta.rootNoteId);
}

/** The actual task/first occurrence is the only persistent journal anchor. Never creates notes/folders. */
export class JournalRepository {
  readonly userData: UserDataStore;
  private readonly anchors = new Map<string, string>();
  private readonly roles = new Map<string, ControlMeta['role']>();
  constructor(readonly gateway: JoplinGateway, readonly local: LocalIntentStore,
    readonly pluginId = DEFAULT_PLUGIN_ID, private readonly now: () => number = Date.now) {
    this.userData = new UserDataStore(gateway, pluginId, stableStringify);
  }
  registerBinding(seriesId: string, rootNoteId: string): void {
    requireId(seriesId); requireId(rootNoteId);
    const existing = this.anchors.get(seriesId);
    if (existing && existing !== rootNoteId) throw new StorageError('ANCHOR_CONFLICT', '同一任务系列关联到不同首篇，已暂停。', { seriesId, noteId: rootNoteId });
    this.anchors.set(seriesId, rootNoteId);
  }
  registerAnchor(seriesId: string, rootNoteId: string): void { this.registerBinding(seriesId, rootNoteId); }
  controlId(seriesId: string): string {
    const id = this.anchors.get(seriesId);
    if (!id) throw new StorageError('ANCHOR_BINDING_MISSING', '任务首篇关联尚未加载；不会新建控制笔记。', { seriesId });
    return id;
  }
  async createControl(meta: ControlMeta): Promise<NativeNote> {
    validateControlMeta(meta, meta.rootNoteId);
    const note = await this.requireAnchor(meta.rootNoteId);
    await this.userData.append(note.id, scopeKey(meta.seriesId), meta);
    this.registerBinding(meta.seriesId, note.id); this.roles.set(meta.seriesId, meta.role);
    return this.requireAnchor(note.id);
  }
  async append(noteId: string, operation: JournalOperation, scopeId?: string): Promise<void> {
    const scoped = scopeId ?? ('seriesId' in operation ? operation.seriesId : undefined) ?? this.uniqueScope(noteId, operation.kind.startsWith('Single') ? 'single' : undefined);
    if (operation.schemaVersion !== 1 || operation.payloadHash !== stableHash(operation.payload)) throw new StorageError('INVALID_OPERATION_HASH', '操作内容校验失败。');
    if ('seriesId' in operation && operation.seriesId !== scoped) throw new StorageError('OPERATION_SCOPE', '操作与存储作用域不一致。');
    const meta = await this.userData.get<ControlMeta>(noteId, scopeKey(scoped));
    validateControlMeta(meta, noteId);
    if (meta.seriesId !== scoped) throw new StorageError('OPERATION_SCOPE', '作用域标记不匹配。');
    if ((meta.role === 'single') !== singleKinds.has(operation.kind)) throw new StorageError('OPERATION_SCOPE', '操作类型与普通任务/重复系列作用域不一致。');
    this.registerBinding(scoped, noteId);
    await this.requireAnchor(noteId);
    const intent = { id: operation.opId, controlNoteId: noteId, phase: `v3:journal-pending:${scoped}`, operation, updatedAt: this.now(), attempts: 0 };
    await this.local.put(intent);
    await this.userData.append(noteId, operationKey(scoped, operation.opId), operation);
    await this.local.put({ ...intent, phase: `v3:journal-saved:${scoped}` });
  }
  async operations<T extends JournalOperation>(note: NativeNote, scopeId?: string): Promise<T[]> {
    const scoped = scopeId ?? await this.scopeFromNote(note);
    const meta = await this.userData.fromNote<ControlMeta>(note, scopeKey(scoped));
    validateControlMeta(meta, note.id);
    if (meta.seriesId !== scoped) throw new StorageError('OPERATION_SCOPE', '日志作用域与任务标记不一致。');
    this.roles.set(scoped, meta.role);
    const keys = (await this.userData.keys(note)).filter(key => key.startsWith(operationPrefix(scoped))).sort();
    const entries: T[] = [];
    for (const key of keys) {
      const operation = await this.userData.fromNote<T>(note, key);
      if (!operation || operation.schemaVersion !== 1 || typeof operation.opId !== 'string' || !Array.isArray(operation.parents) || typeof operation.kind !== 'string' || operation.payloadHash !== stableHash(operation.payload) || ('seriesId' in operation && operation.seriesId !== scoped))
        throw new StorageError('INVALID_JOURNAL', '日志版本、作用域或内容校验失败，已停止该任务的自动写入。', { noteId: note.id });
      if (key !== operationKey(scoped, operation.opId)) throw new StorageError('INVALID_JOURNAL', '日志键与操作身份不匹配。', { noteId: note.id, key });
      if ((meta.role === 'single') !== singleKinds.has(operation.kind)) throw new StorageError('INVALID_JOURNAL', '日志类型与普通任务/重复系列作用域不一致。', { noteId: note.id });
      entries.push(operation);
    }
    return entries;
  }
  async writeCarrier(noteId: string, meta: CarrierMeta): Promise<void> {
    this.validateCarrier(meta);
    await this.requireAnchor(noteId);
    await this.userData.append(noteId, carrierKey(meta.seriesId, meta.occurrenceId), meta);
  }
  async readCarriers(note: NativeNote): Promise<CarrierMeta[]> {
    const rows = await this.userData.entries<CarrierMeta>(note, V3_PREFIXES.carrier);
    rows.forEach(meta => this.validateCarrier(meta)); return rows;
  }
  async reanchor(seriesId: string, targetNoteId: string, transferId: string): Promise<ControlMeta> {
    const sourceId = this.controlId(seriesId);
    const source = await this.requireAnchor(sourceId);
    const sourceMeta = await this.userData.get<ControlMeta>(sourceId, scopeKey(seriesId));
    validateControlMeta(sourceMeta, sourceId);
    if (sourceId === targetNoteId) return sourceMeta;
    await this.requireAnchor(targetNoteId);
    const existing = await this.userData.get<ControlMeta>(targetNoteId, scopeKey(seriesId));
    const meta: ControlMeta = existing ?? { ...sourceMeta, rootNoteId: targetNoteId,
      anchorGeneration: (sourceMeta.anchorGeneration ?? 0) + 1, transferId,
      ancestorNoteIds: [...new Set([...(sourceMeta.ancestorNoteIds ?? []), sourceId])] };
    validateControlMeta(meta, targetNoteId);
    if (!meta.transferId || !meta.ancestorNoteIds?.includes(sourceId)) throw new StorageError('ANCHOR_CONFLICT', '新载体已有不同的系列关联。');
    // An immutable scope alone is a PREPARE, never authority. Commit follows verified copy.
    await this.userData.append(targetNoteId, scopeKey(seriesId), meta);
    const key = commitKey(seriesId, meta.transferId);
    let commit = await this.userData.get<AnchorCommit>(targetNoteId, key);
    if (!commit) {
      const operations = await this.operations<JournalOperation>(source, seriesId);
      const operationHashes: Record<string, string> = {};
      for (const op of operations) {
        await this.userData.append(targetNoteId, operationKey(seriesId, op.opId), op);
        operationHashes[op.opId] = stableHash(op);
      }
      commit = { schemaVersion: 3, seriesId, transferId: meta.transferId, rootNoteId: targetNoteId,
        ancestorNoteIds: meta.ancestorNoteIds!, operationHashes };
      await this.userData.append(targetNoteId, key, commit);
    }
    await this.verifyCommit(meta, commit);
    this.anchors.set(seriesId, targetNoteId); this.roles.set(seriesId, meta.role);
    return meta;
  }
  /** Explicit user retry only. Never runs as part of read-only discovery. */
  async mergeRetired(seriesId: string): Promise<void> {
    const candidates: Array<{note: NativeNote; meta: ControlMeta}> = [];
    for (const note of await this.gateway.allNotes()) {
      if (note.deleted_time || note.encryption_applied || note.is_conflict) continue;
      if (!(await this.userData.keys(note)).includes(scopeKey(seriesId))) continue;
      const meta = await this.userData.get<ControlMeta>(note.id, scopeKey(seriesId));
      validateControlMeta(meta, note.id);
      if (meta.seriesId !== seriesId) throw new StorageError('OPERATION_SCOPE', '载体作用域不匹配。');
      if (meta.transferId) {
        const commit = await this.userData.get<AnchorCommit>(note.id, commitKey(seriesId, meta.transferId));
        // A scope without commit remains a prepared target, never an authority.
        if (!commit) continue;
        await this.verifyCommit(meta, commit);
      }
      candidates.push({note, meta});
    }
    if (!candidates.length) return; // Preserve the ordinary missing-root retry diagnostics.
    const ancestors = new Set(candidates.flatMap(row => row.meta.ancestorNoteIds ?? []));
    const heads = candidates.filter(row => !ancestors.has(row.note.id));
    if (heads.length !== 1) throw new StorageError('ANCHOR_CONFLICT', '无法确定唯一已提交载体，未合并任何日志。', {seriesId});
    const head = heads[0]!;
    const allowed = new Set(head.meta.ancestorNoteIds ?? []);
    const merged = new Map<string, JournalOperation>();
    const active = new Set<string>();
    // Validate the complete available union before making any writes.
    for (const row of candidates) {
      if (row !== head && !allowed.has(row.note.id)) throw new StorageError('ANCHOR_CONFLICT', '存在未关联的系列载体，未合并日志。');
      for (const op of await this.operations<JournalOperation>(row.note, seriesId)) {
        const prior = merged.get(op.opId);
        if (prior && stableHash(prior) !== stableHash(op)) throw new StorageError('IMMUTABLE_KEY_CONFLICT', '旧载体与新载体的同一操作内容不同，未合并日志。', {seriesId, opId: op.opId});
        merged.set(op.opId, op);
        if (row === head) active.add(op.opId);
      }
    }
    // Append-only; a failure can be retried. No native fields, body or commit is rewritten.
    for (const [id, op] of [...merged].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!active.has(id)) await this.userData.append(head.note.id, operationKey(seriesId, id), op);
    }
    this.anchors.set(seriesId, head.note.id); this.roles.set(seriesId, head.meta.role);
  }
  private async verifyCommit(meta: ControlMeta, commit: AnchorCommit | undefined): Promise<void> {
    if (!commit || commit.schemaVersion !== 3 || commit.seriesId !== meta.seriesId || commit.rootNoteId !== meta.rootNoteId || commit.transferId !== meta.transferId || !Array.isArray(commit.ancestorNoteIds) || stableStringify(commit.ancestorNoteIds) !== stableStringify(meta.ancestorNoteIds) || !commit.operationHashes || typeof commit.operationHashes !== 'object')
      throw new StorageError('ANCHOR_TRANSFER_PENDING', '载体转移尚未提交，请等待同步或重试。');
    for (const [id, hash] of Object.entries(commit.operationHashes)) {
      const op = await this.userData.get<JournalOperation>(meta.rootNoteId, operationKey(meta.seriesId, id));
      if (!op || stableHash(op) !== hash) throw new StorageError('ANCHOR_TRANSFER_PENDING', '载体转移日志尚未同步完整。');
    }
  }
  async discover(notes: NativeNote[], fixedFirst = false, incremental = false): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { controls: [], templates: [], carriers: [], issues: [] };
    const candidates: Array<{note: NativeNote; meta: ControlMeta}> = [];
    if (!incremental) { this.anchors.clear(); this.roles.clear(); }
    for (const note of notes) {
      if (note.deleted_time || note.encryption_applied || note.is_conflict) continue;
      try {
        for (const key of (await this.userData.keys(note)).filter(isCurrentStorageKey).sort()) {
          if (key.startsWith(V3_PREFIXES.scope)) {
            const meta = await this.userData.fromNote<ControlMeta>(note, key); validateControlMeta(meta, note.id);
            if (key !== scopeKey(meta.seriesId)) throw new StorageError('INVALID_CONTROL', '任务作用域键与标记不匹配。');
            if (meta.transferId) {
              try { await this.verifyCommit(meta, await this.userData.get<AnchorCommit>(note.id, commitKey(meta.seriesId, meta.transferId))); }
              catch (error) { result.issues.push({ noteId: note.id, seriesId: meta.seriesId, message: error instanceof Error ? error.message : String(error) }); continue; }
            }
            candidates.push({note, meta});
          } else if (key.startsWith(V3_PREFIXES.carrier)) {
            const meta = await this.userData.fromNote<CarrierMeta>(note, key); this.validateCarrier(meta);
            if (key !== carrierKey(meta.seriesId, meta.occurrenceId)) throw new StorageError('INVALID_CARRIER', '执行关联键不匹配。');
            result.carriers.push({note, meta});
          }
        }
      } catch (error) { result.issues.push({ noteId: note.id, message: error instanceof Error ? error.message : String(error) }); }
    }
    for (const id of new Set(candidates.map(row => row.meta.seriesId))) {
      const group = candidates.filter(row => row.meta.seriesId === id);
      const retired = new Set(group.flatMap(row => row.meta.ancestorNoteIds ?? []));
      const heads = group.filter(row => !retired.has(row.note.id));
      if (heads.length !== 1) { for (const row of heads) result.issues.push({noteId: row.note.id, seriesId: id, message: '同一系列存在并发载体转移，已暂停。'}); continue; }
      let head = heads[0]!;
      try {
        if (fixedFirst && head.meta.role === 'series') {
          const source = await this.operations<DomainOperation>(head.note, id);
          const firstId = source.find((op): op is Extract<DomainOperation, {kind:'CreateSeries'}> => op.kind === 'CreateSeries')?.payload.first.carrierNoteId;
          if (firstId && firstId !== head.note.id) {
            const first = group.find(row => row.note.id === firstId);
            if (!first || !head.meta.ancestorNoteIds?.includes(firstId)) throw new StorageError('FIRST_ANCHOR_MISSING', '原始首篇缺失或未同步，已停止生成；请恢复原始首篇。');
            const target = await this.operations<DomainOperation>(first.note, id);
            const targetMap = new Map(target.map(op => [op.opId, op]));
            const sourceMap = new Map(source.map(op => [op.opId, op]));
            for (const op of source) if (targetMap.has(op.opId) && stableHash(targetMap.get(op.opId)) !== stableHash(op))
              throw new StorageError('ANCHOR_CONFLICT', '首篇与旧载体存在同 ID 不同内容的操作，已停止合并。');
            const sourceExtra = source.filter(op => !targetMap.has(op.opId));
            const targetExtra = target.filter(op => !sourceMap.has(op.opId));
            if (sourceExtra.length && targetExtra.length) throw new StorageError('ANCHOR_RETIRED_LATE', '首篇与旧载体均有新增操作，请使用重试显式合并。');
            const combined = reduceSeries([...source, ...target]);
            if (combined.conflicts.length) throw new StorageError('ANCHOR_CONFLICT', '系列日志未完整同步或存在冲突，未写回首篇；请同步并处理后重试。');
            // Preserve immutable transfer records; copy validated logs back, never move or rewrite user notes.
            for (const op of sourceExtra) await this.userData.append(first.note.id, operationKey(id, op.opId), op);
            const refreshed = await this.gateway.getNote(first.note.id);
            if (!refreshed) throw new StorageError('FIRST_ANCHOR_MISSING', '原始首篇在合并期间不可用。');
            head = { note: refreshed, meta: first.meta };
            retired.clear();
            for (const row of group) if (row.note.id !== firstId) retired.add(row.note.id);
          }
        }
        // Late operations on retired roots are preserved and block projection until explicitly merged.
        let late = false;
        const activeOps = new Map((await this.operations<JournalOperation>(head.note, id)).map(op => [op.opId, stableHash(op)]));
        for (const old of group.filter(row => retired.has(row.note.id))) {
          for (const op of await this.operations<JournalOperation>(old.note, id)) {
            if (activeOps.get(op.opId) !== stableHash(op)) { late = true; result.issues.push({noteId: head.note.id, seriesId: id, message: '旧载体收到尚未合并的操作，已暂停；保留两端日志供恢复。'}); break; }
          }
        }
        if (late) continue;
        this.anchors.set(id, head.note.id); this.roles.set(id, head.meta.role); result.controls.push(head);
      } catch (error) {
        result.issues.push({noteId: head.note.id, rootNoteId: head.note.id, seriesId: id, message: error instanceof Error ? error.message : String(error)});
      }
    }
    return result;
  }
  async replayPending(): Promise<void> {
    for (const intent of await this.local.all()) {
      // Old auxiliary-note outboxes are deliberately not replayed or migrated.
      const match = /^v3:journal-pending:(.+)$/.exec(intent.phase);
      if (!match || !intent.operation) continue;
      const scopeId = match[1]!, note = await this.gateway.getNote(intent.controlNoteId);
      if (!note || note.deleted_time || note.encryption_applied || note.is_conflict) continue;
      const meta = await this.userData.get<ControlMeta>(note.id, scopeKey(scopeId));
      if (!meta || meta.schemaVersion !== STORAGE_VERSION || meta.seriesId !== scopeId || meta.rootNoteId !== note.id) continue;
      const operation = intent.operation as JournalOperation;
      if (operation.schemaVersion !== 1 || operation.opId !== intent.id || operation.payloadHash !== stableHash(operation.payload) || ('seriesId' in operation && operation.seriesId !== scopeId)) throw new StorageError('INVALID_JOURNAL', '恢复日志校验失败，未写入首篇。');
      if ((meta.role === 'single') !== singleKinds.has(operation.kind)) throw new StorageError('INVALID_JOURNAL', '恢复操作不属于该作用域，未写入首篇。');
      // Replay only the original immutable intent; discovery decides authority.
      // Late source writes are detected as a merge conflict, never rebind the root here.
      await this.userData.append(note.id, operationKey(scopeId, operation.opId), operation);
    }
  }
  private async requireAnchor(noteId: string): Promise<NativeNote> {
    const note = await this.gateway.getNote(noteId);
    if (!note || note.deleted_time || note.encryption_applied || note.is_conflict) throw new StorageError('ANCHOR_UNAVAILABLE', '任务首篇尚不可用，请同步或恢复；不会新建替代笔记。', { noteId });
    return note;
  }
  private uniqueScope(noteId: string, role?: ControlMeta['role']): string {
    const values = [...this.anchors].filter(([id, note]) => note === noteId && (!role || this.roles.get(id) === role)).map(([id]) => id);
    if (values.length !== 1) throw new StorageError('SCOPE_REQUIRED', '同一首篇有多个任务作用域，请明确指定。', { noteId });
    return values[0]!;
  }
  private async scopeFromNote(note: NativeNote): Promise<string> {
    const keys = (await this.userData.keys(note)).filter(key => key.startsWith(V3_PREFIXES.scope));
    if (keys.length !== 1) throw new StorageError('SCOPE_REQUIRED', '读取日志必须明确唯一作用域。', { noteId: note.id });
    const meta = await this.userData.get<ControlMeta>(note.id, keys[0]!); validateControlMeta(meta, note.id); return meta.seriesId;
  }
  private validateCarrier(value: unknown): asserts value is CarrierMeta {
    const meta = value as CarrierMeta;
    if (!meta || meta.schemaVersion !== STORAGE_VERSION || meta.role !== 'carrier' || !meta.seriesId || !meta.anchorNoteId || !meta.occurrenceId || typeof meta.creationHash !== 'string') throw new StorageError('INVALID_CARRIER', '后继任务的首篇关联尚未同步完整。');
    requireId(meta.seriesId); requireId(meta.anchorNoteId); requireId(meta.occurrenceId);
    if (meta.snapshot) {
      try {
        const snapshot = meta.snapshot;
        if (validateSchedule(snapshot.schedule).length || !['high', 'medium', 'low', 'none'].includes(snapshot.priority) || typeof snapshot.pinned !== 'boolean' || typeof snapshot.reminder?.enabled !== 'boolean' || (snapshot.reminderOverride !== undefined && !Number.isFinite(snapshot.reminderOverride))) throw new Error();
      } catch { throw new StorageError('INVALID_CARRIER', '后继任务的计划快照损坏，已保留原文并停止自动写入。'); }
    }
  }
}

export function operationHeads(operations: Array<{ opId: string; parents: string[] }>): string[] {
  const parents = new Set(operations.flatMap(operation => operation.parents));
  return operations.map(operation => operation.opId).filter(id => !parents.has(id)).sort();
}

/** Partial-order scalar merge. Wall clocks never decide causal ordering. */
export function reduceSingle(operations: SingleOperation[]): Task | undefined {
  const byId = new Map(operations.map(operation => [operation.opId, operation]));
  const sorted: SingleOperation[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (operation: SingleOperation) => {
    if (visited.has(operation.opId)) return;
    if (visiting.has(operation.opId)) throw new StorageError('JOURNAL_CYCLE', '任务日志存在循环依赖。');
    visiting.add(operation.opId);
    for (const id of [...operation.parents].sort()) {
      const parent = byId.get(id);
      if (!parent) throw new StorageError('MISSING_PARENT', '任务日志正在等待其他设备同步。');
      visit(parent);
    }
    visiting.delete(operation.opId);
    visited.add(operation.opId);
    sorted.push(operation);
  };
  for (const operation of [...operations].sort((a, b) => a.opId.localeCompare(b.opId))) visit(operation);
  let task: Task | undefined;
  for (const operation of sorted) {
    if (operation.kind === 'SingleCreate') {
      if (task && stableStringify(task) !== stableStringify(operation.payload.task)) throw new StorageError('SINGLE_CREATE_CONFLICT', '同一任务存在两个不同来源。');
      task = { ...operation.payload.task };
      if (task?.completedAt) task.pinned = false;
    } else if (operation.kind === 'SinglePatch' && task) {
      task = { ...task, ...operation.payload.patch };
      if (task?.completedAt) task.pinned = false;
      if (task && operation.payload.clearReminderOverride) delete task.reminderOverride;
    }
    else if (operation.kind === 'SingleDelete' && task) task = { ...task, managed: false };
  }
  return task;
}
