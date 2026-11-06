/** Public Joplin APIs only. No localhost service, filesystem or private database. */
export interface JoplinApiLike {
  data: {
    get(path: string[], query?: Record<string, unknown> | null): Promise<any>;
    post(path: string[], query?: Record<string, unknown> | null, body?: any, files?: any[]): Promise<any>;
    put(path: string[], query?: Record<string, unknown> | null, body?: any): Promise<any>;
    delete(path: string[], query?: Record<string, unknown> | null): Promise<any>;
    userDataDelete(itemType: number, itemId: string, key: string): Promise<void>;
    userDataGet<T>(itemType: number, itemId: string, key: string): Promise<T | undefined>;
    userDataSet<T>(itemType: number, itemId: string, key: string, value: T): Promise<void>;
  };
  settings: {
    registerSettings(settings: Record<string, any>): Promise<void>;
    registerSection?(name: string, section: Record<string, unknown>): Promise<void>;
    value(key: string): Promise<any>;
    globalValues?(keys: string[]): Promise<any[]>;
    globalValue?(key: string): Promise<any>;
    setValue(key: string, value: any): Promise<void>;
  };
  commands?: { execute(name: string, ...args: any[]): Promise<any> };
  versionInfo?(): Promise<Record<string, unknown>>;
}

export interface NativeNote {
  id: string;
  parent_id: string;
  title: string;
  body: string;
  is_todo: number;
  todo_due: number;
  todo_completed: number;
  updated_time: number;
  user_updated_time?: number;
  created_time?: number;
  user_data?: string;
  deleted_time?: number;
  encryption_applied?: number;
  is_conflict?: number;
  markup_language?: number;
}
export interface NativeFolder { id: string; title: string; parent_id?: string; user_data?: string; encryption_applied?: number; deleted_time?: number; user_updated_time?: number; }
export interface NativeTag { id: string; title: string }
export interface NativeResource { id: string; title?: string; size?: number; }
export type NotePatch = Partial<Pick<NativeNote, 'title' | 'body' | 'parent_id' | 'is_todo' | 'todo_due' | 'todo_completed'>>;
export type CreateNote = NotePatch & { title: string; body: string; parent_id: string };

export class StorageError extends Error {
  constructor(public readonly code: string, message: string, public readonly context?: Record<string, unknown>) {
    super(message);
    this.name = 'StorageError';
  }
}

function isNotFound(error: unknown): boolean {
  const value = error as { status?: number; statusCode?: number; code?: string; message?: string };
  return value?.status === 404 || value?.statusCode === 404 || value?.code === 'not_found' ||
    /(?:^|\b)(?:404|not found|no such note|no such resource)(?:\b|$)/i.test(value?.message || '');
}

export const NOTE_TYPE = 1;
const noteFields = ['id', 'parent_id', 'title', 'body', 'is_todo', 'todo_due', 'todo_completed',
  'updated_time', 'user_updated_time', 'created_time', 'user_data', 'deleted_time', 'encryption_applied', 'is_conflict', 'markup_language'];

export class JoplinGateway {
  readonly changedNoteIds = new Set<string>();
  constructor(public readonly api: JoplinApiLike) {}

  async getNote(id: string, includeBody = true): Promise<NativeNote | null> {
    try {
      const result = await this.api.data.get(['notes', id], { fields: includeBody ? noteFields : noteFields.filter(field => field !== 'body') });
      return result?.id ? result as NativeNote : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async allNotes(options: { includeDeleted?: boolean } = {}): Promise<NativeNote[]> {
    return this.paginate<NativeNote>(['notes'], { ...(options.includeDeleted ? { include_deleted: 1, include_conflicts: 1 } : {}), fields: noteFields.filter(field => field !== 'body'), order_by: 'id', order_dir: 'ASC' });
  }

  /** Small metadata catalog: focus discovers background edits without loading bodies or journals. */
  async noteVersions(): Promise<Pick<NativeNote, 'id' | 'updated_time' | 'deleted_time' | 'encryption_applied' | 'is_conflict'>[]> {
    return this.paginate(['notes'], { fields: ['id', 'updated_time', 'deleted_time', 'encryption_applied', 'is_conflict'],
      include_deleted: 1, include_conflicts: 1, order_by: 'id', order_dir: 'ASC' });
  }

  async paginate<T>(path: string[], query: Record<string, unknown> = {}): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 100000; page++) {
      const response = await this.api.data.get(path, { ...query, page, limit: 100 });
      if (Array.isArray(response)) return response as T[];
      if (!response || !Array.isArray(response.items)) throw new StorageError('INVALID_PAGE', '宿主返回了无法识别的分页数据。');
      result.push(...response.items);
      if (!response.has_more) return result;
      if (!response.items.length) throw new StorageError('INVALID_PAGE', '宿主分页未前进，已停止扫描。');
    }
    throw new StorageError('PAGE_LIMIT', '笔记分页超出安全上限，请检查宿主日志。');
  }

  async folders(): Promise<NativeFolder[]> {
    // Joplin's allForDisplay + allAsTree applies the host's locale, sort field
    // and reverse setting. Preserve that order instead of re-sorting in the panel.
    // Management scans must retain deleted folders; the application filters selectable folders.
    const query = { include_deleted: 1, fields: ['id', 'title', 'parent_id', 'user_updated_time', 'user_data', 'encryption_applied', 'deleted_time'] };
    const roots = await this.api.data.get(['folders'], { ...query, as_tree: 1 });
    const output: NativeFolder[] = [];
    const visited = new Set<string>();
    const walk = (values: any[], parentId = '') => {
      for (const value of values) {
        if (!value?.id || visited.has(value.id)) continue;
        visited.add(value.id);
        const { children, ...folder } = value;
        output.push({ ...folder, parent_id: folder.parent_id ?? parentId } as NativeFolder);
        if (Array.isArray(children)) walk(children, value.id);
      }
    };
    if (Array.isArray(roots)) walk(roots);
    else if (Array.isArray(roots?.items)) {
      walk(roots.items);
      if (roots.has_more) return this.paginate<NativeFolder>(['folders'], query);
    } else throw new StorageError('INVALID_FOLDERS', '无法读取笔记本列表。');
    return output;
  }

  async createFolder(id: string, title: string): Promise<NativeFolder> {
    try {
      return await this.api.data.post(['folders'], null, { id, title });
    } catch (error) {
      const existing = (await this.folders()).find(folder => folder.id === id);
      if (existing?.title === title) return existing;
      throw error;
    }
  }

  /** Retry never PUTs an existing ID: POST's outcome can be unknown after a timeout. */
  async ensureNote(id: string, input: CreateNote): Promise<NativeNote> {
    const matches = (note: NativeNote) => note.parent_id === input.parent_id && note.title === input.title &&
      note.body === input.body && !note.deleted_time && !note.encryption_applied &&
      note.is_todo === (input.is_todo ?? 0);
    let note = await this.getNote(id);
    if (note) {
      if (!matches(note)) throw new StorageError('NOTE_ID_COLLISION', '预定笔记已存在且内容不同，已保留原内容并暂停创建。', { noteId: id });
      return note;
    }
    try {
      this.changedNoteIds.add(id);
      await this.api.data.post(['notes'], null, { ...input, id, todo_due: input.todo_due ?? 0, todo_completed: input.todo_completed ?? 0 });
    } catch (error) {
      note = await this.getNote(id);
      if (!note) throw error;
      if (!matches(note)) throw new StorageError('NOTE_ID_COLLISION', '创建结果身份不同，已暂停恢复。', { noteId: id });
      return note;
    }
    note = await this.getNote(id);
    if (!note || !matches(note)) throw new StorageError('CREATE_READBACK', '创建笔记后读回验证失败；不会重复创建其他笔记。', { noteId: id });
    return note;
  }

  async patchNote(id: string, patch: NotePatch): Promise<NativeNote> {
    const allowed = new Set(['title', 'body', 'parent_id', 'is_todo', 'todo_due', 'todo_completed']);
    if (!Object.keys(patch).every(key => allowed.has(key))) throw new StorageError('UNSAFE_PATCH', '拒绝写入未允许的原生字段。');
    this.changedNoteIds.add(id);
    await this.api.data.put(['notes', id], null, patch);
    const note = await this.getNote(id);
    if (!note) throw new StorageError('MISSING_NOTE', '笔记写入后无法读取。', { noteId: id });
    return note;
  }

  /** Explicit restore only. Ordinary NotePatch never permits deletion-state changes. */
  async restoreNote(id: string): Promise<NativeNote> {
    const note = await this.getNote(id);
    if (!note) throw new StorageError('RESTORE_FIRST_MISSING', '第一篇任务笔记已永久删除，无法恢复。请新建重复任务替代。');
    if (note.encryption_applied || note.is_conflict) throw new StorageError('NOTE_UNAVAILABLE', '笔记暂不可用。');
    if (!note.deleted_time) return note;
    this.changedNoteIds.add(id);
    await this.api.data.put(['notes', id], null, { deleted_time: 0 });
    const restored = await this.getNote(id);
    if (!restored || restored.deleted_time !== 0) throw new StorageError('RESTORE_FIRST_FAILED', '第一篇任务笔记未能恢复，请在 Joplin 中检查回收站后重试。');
    return restored;
  }

  async deleteNote(id: string, permanent = false): Promise<void> { this.changedNoteIds.add(id); await this.api.data.delete(['notes', id], permanent ? { permanent: 1 } : null); }
  async getResource(id: string): Promise<NativeResource | null> {
    try { return await this.api.data.get(['resources', id], { fields: ['id', 'title', 'size'] }); }
    catch (error) { if (isNotFound(error)) return null; throw error; }
  }
  async tags(): Promise<NativeTag[]> {
    return this.paginate<NativeTag>(['tags'], { fields: ['id', 'title'], order_by: 'title', order_dir: 'ASC' });
  }
  async tagNoteIds(id: string): Promise<string[]> {
    const notes = await this.paginate<{ id: string }>(['tags', id, 'notes'], { fields: ['id'] });
    return notes.map(note => note.id);
  }
  async noteTags(id: string): Promise<string[]> {
    const tags = await this.paginate<{ id: string }>(['notes', id, 'tags'], { fields: ['id'] });
    return tags.map(tag => tag.id);
  }
  async addTags(id: string, tags: readonly string[]): Promise<void> {
    for (const tagId of tags) await this.api.data.post(['tags', tagId, 'notes'], null, { id });
  }
  async openNote(id: string): Promise<void> { await this.api.commands?.execute('openNote', id); }
}
