import { LOCAL_SETTINGS_PREFIX } from '../shared/pluginIdentity';
import { createTranslator, resolveLanguage } from '../i18n';
import { REPORT_ISSUE_URL, SUPPORT_AUTHOR_URL } from '../shared/externalLinks';
import type { ApplicationCommand, ViewQuery } from '../services/applicationTypes';
import type { TaskApplication } from '../services/taskApplication';
import { StorageError } from '../adapters/joplin/gateway';
import type { JoplinApiLike } from '../adapters/joplin/gateway';
export interface RuntimeApi extends JoplinApiLike {
  plugins?: { installationDir(): Promise<string> };
  window?: { loadChromeCssFile(path: string): Promise<void> };
  views: {
    dialogs?: { showMessageBox(message: string): Promise<number>;
      create?(id: string): Promise<string>; setHtml?(id: string, html: string): Promise<unknown>;
      setButtons?(id: string, buttons: { id: string; title: string }[]): Promise<unknown>;
      open?(id: string): Promise<{ id: string }> };
    panels: { create(id: string): Promise<string>; setHtml(id: string, html: string): Promise<unknown>;
      addScript(id: string, path: string): Promise<void>; onMessage(id: string, handler: (message: any) => Promise<any>): Promise<void>;
      postMessage(id: string, message: unknown): void; show(id: string, visible?: boolean): Promise<void>; visible?(id: string): Promise<boolean> };
    toolbarButtons?: { create(id: string, commandName: string, location: string): Promise<void> };
    menuItems?: { create(id: string, commandName: string, location?: string): Promise<void> };
    menus?: { create(id: string, label: string, items: unknown[], location?: string): Promise<void> };
  };
  commands: { register?(command: { name: string; label: string; iconName?: string; enabledCondition?: string; execute: (...args: any[]) => Promise<unknown> }): Promise<void>; execute(name: string, ...args: any[]): Promise<any> };
  workspace?: {
    selectedNote?(): Promise<{ id: string; body?: string } | null>;
    onNoteChange?(handler: (event?: { id?: string; noteId?: string }) => void): Promise<{ dispose?(): void }>;
    onSyncComplete?(handler: () => void): Promise<{ dispose?(): void }>;
    onNoteSelectionChange?(handler: (event?: { value?: string[] }) => void): Promise<{ dispose?(): void }>;
  };
}
const actions = new Set(['insertTemplateBlock', 'changeDate', 'abandonTask', 'moveTask', 'deleteNativeTask', 'createTask', 'editTask', 'complete', 'skip', 'reopen', 'snooze', 'reviseSeries', 'switchMode', 'deleteTask', 'setFields', 'adoptNativeDate', 'resolveConflict', 'keepOccurrence', 'dismissDetached', 'openNote', 'savePreferences', 'refresh', 'restoreFirstNote', 'retrySeries', 'previewCleanup', 'executeCleanup']);
type PanelMode = 'expanded' | 'collapsed' | 'hidden';
const panelModeKey = LOCAL_SETTINGS_PREFIX + 'panelMode';
const views = new Set(['inbox', 'today', 'tomorrow', 'sevenDays', 'week', 'month', 'year', 'all', 'day']);
export class PanelController {
  private handle = '';
  private compactHandle = '';
  private mode: PanelMode = 'hidden';
  private startupMode: PanelMode = 'expanded';
  private visibilityQueue: Promise<unknown> = Promise.resolve();
  private pendingUiAction?: { type: 'new' | 'series' | 'edit'; noteId?: string };
  constructor(private readonly api: RuntimeApi, private readonly app: TaskApplication) {}
  async initialize(): Promise<void> {
    if (this.api.settings?.registerSettings) {
      await this.api.settings.registerSettings({
        [panelModeKey]: { value: 'expanded', type: 2, public: false, label: 'Panel visibility' },
      });
      const saved = await this.api.settings.value(panelModeKey);
      if (saved === 'expanded' || saved === 'collapsed' || saved === 'hidden') this.startupMode = saved;
    }
    this.handle = await this.api.views.panels.create('journey.tasks.panel');
    if (this.startupMode !== 'expanded') await this.api.views.panels.show(this.handle, false);
    await this.api.views.panels.setHtml(this.handle, '<div id="root" lang="zh-CN"></div>');
    await this.api.views.panels.onMessage(this.handle, message => this.handleMessage(message));
    await this.api.views.panels.addScript(this.handle, 'panel.css');
    await this.api.views.panels.addScript(this.handle, 'panel.js');
  }
  /** Enabled only after desktop chrome CSS has loaded successfully. */
  async enableCompact(): Promise<void> {
    const panels = this.api.views.panels;
    const handle = await panels.create('journey.tasks.mini');
    await panels.show(handle, false);
    await panels.setHtml(handle, '<button id="restore" type="button" aria-label="Restore panel" title="Restore panel"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6m6-12-6 6 6 6"/></svg></button>');
    await panels.onMessage(handle, message => {
      if (!['miniReady', 'restorePanel'].includes(message?.action)) return Promise.resolve({ ok: false, code: 'UNSUPPORTED_ACTION' });
      return this.handleMessage(message);
    });
    await panels.addScript(handle, 'mini.css');
    await panels.addScript(handle, 'mini.js');
    this.compactHandle = handle;
  }
  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.visibilityQueue.then(operation);
    this.visibilityQueue = next.catch(() => {});
    return next;
  }
  private async visibility(): Promise<{ main: boolean; mini: boolean }> {
    // Start each optional API lookup from the root: Joplin mutates cached proxy paths.
    return {
      main: this.api.views.panels.visible ? await this.api.views.panels.visible(this.handle) : this.mode === 'expanded',
      mini: this.compactHandle ? (this.api.views.panels.visible ? await this.api.views.panels.visible(this.compactHandle) : this.mode === 'collapsed') : false,
    };
  }
  private async setMode(mode: PanelMode, remember = true): Promise<void> {
    if (!this.handle) return;
    const panels = this.api.views.panels;
    const previous = await this.visibility();
    try {
      // Show the destination first so a failed transition retains a recovery path.
      if (mode === 'expanded') await panels.show(this.handle, true);
      if (mode === 'collapsed') await panels.show(this.compactHandle, true);
      if (mode !== 'expanded') await panels.show(this.handle, false);
      if (this.compactHandle && mode !== 'collapsed') await panels.show(this.compactHandle, false);
      if (remember && this.api.settings?.setValue) await this.api.settings.setValue(panelModeKey, mode);
      this.mode = mode;
      if (mode === 'expanded') this.api.views.panels.postMessage(this.handle, { type: 'restorePanel', protocolVersion: 1 });
    } catch (error) {
      await panels.show(this.handle, previous.main).catch(() => {});
      if (this.compactHandle) await panels.show(this.compactHandle, previous.mini).catch(() => {});
      throw error;
    }
  }
  restoreStartup(): Promise<void> {
    return this.serialize(() => this.setMode(this.startupMode === 'collapsed' && !this.compactHandle ? 'expanded' : this.startupMode, false));
  }
  show(): Promise<void> { return this.serialize(() => this.setMode('expanded')); }
  toggle(): Promise<void> {
    return this.serialize(async () => {
      const { main, mini } = await this.visibility();
      await this.setMode(main || mini ? 'hidden' : 'expanded');
    });
  }
  private async restoreLabel(): Promise<string> {
    const snapshot = await this.app.snapshot();
    return createTranslator(resolveLanguage(snapshot.preferences.language, snapshot.systemLocale))('panel.restore');
  }
  async openEditor(type: 'new' | 'series' | 'edit', noteId?: string): Promise<void> { this.pendingUiAction = { type, noteId }; await this.show(); this.invalidate(); }
  invalidate(): void { if (this.handle) this.api.views.panels.postMessage(this.handle, { type: 'invalidate', protocolVersion: 1 }); }
  async handleMessage(message: any): Promise<any> {
    try {
      if (!message || message.protocolVersion !== 1 || typeof message.requestId !== 'string' || message.requestId.length > 200 || JSON.stringify(message).length > 2_000_000) throw new StorageError('INVALID_REQUEST', '无效的面板请求');
      if (message.action === 'collapsePanel') {
        if (this.compactHandle) {
          await this.serialize(async () => {
            const label = await this.restoreLabel();
            this.api.views.panels.postMessage(this.compactHandle, { type: 'restoreLabel', label });
            await this.setMode('collapsed');
          });
        }
        return { ok: true, compact: !!this.compactHandle };
      }
      if (message.action === 'restorePanel') { await this.show(); return { ok: true }; }
      if (message.action === 'miniReady') return { ok: true, label: await this.restoreLabel() };
      if (message.action === 'reportIssue' || message.action === 'supportAuthor') {
        await this.api.commands.execute('openItem', message.action === 'reportIssue' ? REPORT_ISSUE_URL : SUPPORT_AUTHOR_URL);
        return { ok: true };
      }
      if (message.action === 'ready' || message.action === 'snapshot') {
        const q = message.query ?? {};
        if ((q.search !== undefined && typeof q.search !== 'string') || (q.notebookIds !== undefined && (!Array.isArray(q.notebookIds) || q.notebookIds.some((id: unknown) => typeof id !== 'string'))) || (q.view && !views.has(q.view)) || (q.date && (typeof q.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(q.date))) || (q.showCompleted !== undefined && typeof q.showCompleted !== 'boolean') || (q.notebookId !== undefined && typeof q.notebookId !== 'string') || (q.tagId !== undefined && typeof q.tagId !== 'string') || (q.deviceZone && typeof q.deviceZone !== 'string')) throw new StorageError('INVALID_VIEW', '无效的视图参数');
        const query: ViewQuery = { search: q.search, notebookIds: q.notebookIds, view: q.view, date: q.date, showCompleted: q.showCompleted, notebookId: q.notebookId, tagId: q.tagId, deviceZone: q.deviceZone };
        const snapshot = await this.app.snapshot(query); const uiAction = this.pendingUiAction; this.pendingUiAction = undefined;
        return { ok: true, snapshot, ...(uiAction ? { uiAction } : {}) };
      }
      if (message.action !== 'command' || !message.command || !actions.has(message.command.action) || message.command.requestId !== message.requestId) throw new StorageError('UNSUPPORTED_ACTION', '不支持的操作');
      return { ok: true, result: await this.app.dispatch(message.command as ApplicationCommand) };
    } catch (error) { return { ok: false, error: (error as Error).message || '操作失败', code: error instanceof StorageError ? error.code : 'COMMAND_FAILED' }; }
  }
}
