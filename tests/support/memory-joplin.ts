type Row = Record<string, any> & { id: string };
type Fault = { method: string; path: string; afterCommit?: boolean; error: Error };

const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);
const missing = (id: string) => Object.assign(new Error(`Not found: ${id}`), { code: 404, status: 404 });

/** A deliberately small fake, not a simulator of Joplin's synchronization protocol. */
export class MemoryJoplin {
  readonly notes = new Map<string, Row>();
  readonly notebooks = new Map<string, Row>();
  readonly tags = new Map<string, Row>();
  readonly noteTagIds = new Map<string, Set<string>>();
  readonly resources = new Map<string, Row>();
  readonly settingsValues = new Map<string, unknown>();
  readonly calls: Array<{ method: string; path: string[]; query?: any; body?: any }> = [];
  readonly faults: Fault[] = [];
  pageSize = 2;
  namespace = 'test.plugin';
  private sequence = 0;
  private timestamp = 100;

  seedNote(input: Partial<Row> & { id: string }): Row {
    const note = {
      title: 'Task', body: '', parent_id: 'notebook', is_todo: 1,
      todo_due: 0, todo_completed: 0, deleted_time: 0, user_data: '{}',
      created_time: ++this.timestamp, updated_time: this.timestamp, ...clone(input),
    };
    this.notes.set(note.id, note);
    return clone(note);
  }

  failNext(method: string, path: string, afterCommit = false): void {
    this.faults.push({ method, path, afterCommit, error: new Error(`Injected ${method} ${path}`) });
  }

  private fault(method: string, path: string[], afterCommit: boolean): void {
    const index = this.faults.findIndex(f => f.method === method && f.path === path.join('/') && !!f.afterCommit === afterCommit);
    if (index >= 0) throw this.faults.splice(index, 1)[0]!.error;
  }

  private table(path: string[]): Map<string, Row> {
    if (path[0] === 'notes') return this.notes;
    if (path[0] === 'folders') return this.notebooks;
    if (path[0] === 'resources') return this.resources;
    if (path[0] === 'tags') return this.tags;
    throw new Error(`Unsupported fake path ${path.join('/')}`);
  }

  readonly data = {
    get: async (path: string[], query: Record<string, any> = {}): Promise<any> => {
      this.calls.push({ method: 'get', path: [...path], query: clone(query) });
      this.fault('get', path, false);
      const project = (row: Row): Row => path[0] === 'folders' && Array.isArray(query.fields)
        ? Object.fromEntries(query.fields.filter((key: string) => key in row).map((key: string) => [key, clone(row[key])])) as Row
        : clone(row);
      const table = this.table(path);
      if (path.length > 1) {
        const row = table.get(path[1]!);
        if (!row) throw missing(path[1]!);
        if (path[2] === 'tags') {
          const rows = [...(this.noteTagIds.get(path[1]!) || [])].map(id => this.tags.get(id) || { id, title: id });
          const size = Math.min(Number(query.limit ?? this.pageSize), this.pageSize);
          const offset = (Number(query.page ?? 1) - 1) * size;
          return { items: clone(rows.slice(offset, offset + size)), has_more: offset + size < rows.length };
        }
        if (path[0] === 'tags' && path[2] === 'notes') {
          const rows = [...this.notes.values()].filter(note => this.noteTagIds.get(note.id)?.has(path[1]!));
          const size = Math.min(Number(query.limit ?? this.pageSize), this.pageSize);
          const offset = (Number(query.page ?? 1) - 1) * size;
          return { items: clone(rows.slice(offset, offset + size)), has_more: offset + size < rows.length };
        }
        // Joplin's single-note model load adds type_, while paginated SQL rows do not.
        return path[0] === 'notes' ? { ...project(row), type_: 1 } : project(row);
      }
      let rows = [...table.values()];
      if ((path[0] === 'folders' || path[0] === 'notes') && !query.include_deleted) rows = rows.filter(row => !row.deleted_time);
      if (query.is_todo !== undefined) rows = rows.filter(row => row.is_todo === query.is_todo);
      if (query.parent_id !== undefined) rows = rows.filter(row => row.parent_id === query.parent_id);
      const size = Math.min(Number(query.limit ?? this.pageSize), this.pageSize);
      const offset = (Number(query.page ?? 1) - 1) * size;
      return { items: rows.slice(offset, offset + size).map(project), has_more: offset + size < rows.length };
    },
    post: async (path: string[], query: Record<string, any> = {}, input: Record<string, any> = {}): Promise<any> => {
      this.calls.push({ method: 'post', path: [...path], query: clone(query), body: clone(input) });
      this.fault('post', path, false);
      if (path[0] === 'tags' && path[2] === 'notes') {
        const ids = this.noteTagIds.get(input.id) || new Set<string>(); ids.add(path[1]!); this.noteTagIds.set(input.id, ids);
        this.fault('post', path, true); return { id: input.id };
      }
      const table = this.table(path);
      const id = input.id ?? (++this.sequence).toString(16).padStart(32, '0');
      if (table.has(id)) throw Object.assign(new Error(`Already exists: ${id}`), { code: 409, status: 409 });
      const row = path[0] === 'notes'
        ? this.seedNote({ ...input, id })
        : { ...clone(input), id };
      table.set(id, clone(row));
      this.fault('post', path, true);
      return clone(row);
    },
    put: async (path: string[], query: Record<string, any> = {}, input: Record<string, any> = {}): Promise<any> => {
      this.calls.push({ method: 'put', path: [...path], query: clone(query), body: clone(input) });
      this.fault('put', path, false);
      const table = this.table(path);
      const row = table.get(path[1]!);
      if (!row) throw missing(path[1]!);
      const updated = { ...row, ...clone(input), updated_time: ++this.timestamp };
      table.set(row.id, updated);
      this.fault('put', path, true);
      return clone(updated);
    },
    delete: async (path: string[], query: Record<string, any> | null = {}): Promise<void> => {
      this.calls.push({ method: 'delete', path: [...path], query: clone(query) });
      this.fault('delete', path, false);
      if (path[0] === 'folders') {
        // Real notebook removal can remove descendants: callers must not rely on
        // the fake to protect unrelated child notebooks or user notes for them.
        const removed = new Set([path[1]!]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const [id, folder] of this.notebooks) {
            if (removed.has(folder.parent_id) && !removed.has(id)) { removed.add(id); changed = true; }
          }
        }
        for (const [id, note] of this.notes) if (removed.has(note.parent_id)) {
          if (query?.permanent) this.notes.delete(id);
          else this.notes.set(id, { ...note, deleted_time: ++this.timestamp, updated_time: this.timestamp });
        }
        for (const id of removed) {
          if (query?.permanent) this.notebooks.delete(id);
          else this.notebooks.set(id, { ...this.notebooks.get(id)!, deleted_time: ++this.timestamp });
        }
      } else if (path[0] === 'notes' && !query?.permanent) {
        const note = this.notes.get(path[1]!);
        if (!note) throw missing(path[1]!);
        this.notes.set(note.id, { ...note, deleted_time: ++this.timestamp, updated_time: this.timestamp });
      } else this.table(path).delete(path[1]!);
      this.fault('delete', path, true);
    },
    userDataGet: async <T>(_type: number, id: string, key: string): Promise<T | undefined> => {
      this.calls.push({ method: 'userDataGet', path: [id, key] });
      this.fault('userDataGet', [id, key], false);
      const row = (_type === 2 ? this.notebooks : this.notes).get(id);
      if (!row) throw missing(id);
      const entry = JSON.parse(row.user_data || '{}')[this.namespace]?.[key];
      return entry?.d ? undefined : clone(entry?.v);
    },
    userDataSet: async <T>(_type: number, id: string, key: string, value: T): Promise<void> => {
      this.calls.push({ method: 'userDataSet', path: [id, key], body: clone(value) });
      this.fault('userDataSet', [id, key], false);
      const row = (_type === 2 ? this.notebooks : this.notes).get(id);
      if (!row) throw missing(id);
      const envelope = JSON.parse(row.user_data || '{}');
      envelope[this.namespace] ??= {};
      envelope[this.namespace][key] = { v: clone(value), t: ++this.timestamp };
      row.user_data = JSON.stringify(envelope);
      this.fault('userDataSet', [id, key], true);
    },
    userDataDelete: async (_type: number, id: string, key: string): Promise<void> => {
      this.calls.push({ method: 'userDataDelete', path: [id, key] });
      this.fault('userDataDelete', [id, key], false);
      const row = (_type === 2 ? this.notebooks : this.notes).get(id);
      if (!row) throw missing(id);
      const envelope = JSON.parse(row.user_data || '{}');
      envelope[this.namespace] ??= {};
      envelope[this.namespace][key] = { t: ++this.timestamp, d: 1 };
      row.user_data = JSON.stringify(envelope);
      this.fault('userDataDelete', [id, key], true);
    },
  };

  readonly settings = {
    registerSettings: async (_settings: Record<string, any>): Promise<void> => {},
    value: async (key: string): Promise<any> => clone(this.settingsValues.get(key)),
    setValue: async (key: string, value: unknown): Promise<void> => { this.settingsValues.set(key, clone(value)); },
  };

  /** Copy chosen records to model partial arrival. No real merge semantics are implied. */
  deliverNotesTo(peer: MemoryJoplin, ids: string[]): void {
    for (const id of ids) {
      const row = this.notes.get(id);
      if (row) peer.notes.set(id, clone(row));
    }
  }

  mutations(): typeof this.calls {
    return this.calls.filter(call => !['get', 'userDataGet'].includes(call.method));
  }
}
