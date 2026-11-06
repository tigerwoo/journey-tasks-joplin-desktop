import { addDays } from './domain/dates';
import { resolveZonedTime, timezoneAdapter } from './adapters/calendar/timezoneAdapter';
import { BODY_TEMPLATE_MARKERS, parseArchiveBody } from './domain/bodyTemplate';
import { createTranslator, resolveLanguage, translateMessage } from './i18n';
import { TaskApplication } from './services/taskApplication';
import { PanelController, type RuntimeApi } from './panel/controller';
export async function startPlugin(api: RuntimeApi): Promise<{ app: TaskApplication; panel: PanelController; dispose(): void }> {
  let panel: PanelController | undefined;
  const notices = new Set<string>();
  let stopped = false;
  let noticeQueue: Promise<void> = Promise.resolve();
  let restoreDialog: string | undefined;
  let restoreSequence = 0;
  const app = new TaskApplication(api, { onChange: () => panel?.invalidate(), onNotice: (message, restore) => {
    const key = restore ? `${restore.seriesId}:${restore.noteId}` : message;
    if (notices.has(key) || stopped) return;
    notices.add(key);
    // Do not await user input inside the task write queue. A chosen restore gets its own queued command.
    noticeQueue = noticeQueue.catch(() => {}).then(async () => {
      if (stopped) return;
      if (!restore) { await api.views.dialogs?.showMessageBox(message); return; }
      const locale = await app.interfaceLocale();
      const t = createTranslator(locale);
      const restoreError = (code?: string) => t(({
        RESTORE_FIRST_MISSING: 'backend.RESTORE_FIRST_MISSING', RESTORE_FIRST_INVALID: 'backend.RESTORE_FIRST_INVALID',
        RESTORE_FIRST_ENDED: 'backend.RESTORE_FIRST_ENDED', RESTORE_FIRST_NOTEBOOK: 'backend.RESTORE_FIRST_NOTEBOOK',
        RESTORE_FIRST_FAILED: 'backend.RESTORE_FIRST_FAILED',
      } as Record<string, string>)[code || ''] || 'backend.RESTORE_FIRST_FAILED');
      let choice: { id: string } | undefined;
      try {
        restoreDialog ??= await api.views.dialogs?.create?.('journey.restoreFirst');
        if (!restoreDialog) { await api.views.dialogs?.showMessageBox(message); return; }
        const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        await api.views.dialogs!.setHtml!(restoreDialog, `<p dir="auto" style="white-space: pre-wrap; overflow-wrap: anywhere">${escaped}</p>`);
        await api.views.dialogs!.setButtons!(restoreDialog, [
          { id: 'restore-first', title: restore.convert ? t('actions.convertToTodo') : t('actions.restoreCurrent') }, { id: 'cancel', title: t('actions.notNow') },
        ]);
        choice = await api.views.dialogs!.open!(restoreDialog);
      } catch { restoreDialog = undefined; await api.views.dialogs?.showMessageBox(message); return; }
      if (choice?.id !== 'restore-first' || stopped) {
        if (restore.convert && !stopped) await app.dispatch({ action: 'dismissDetached', seriesId: restore.seriesId, noteId: restore.noteId, requestId: `detach:${Date.now()}:${++restoreSequence}` });
        return;
      }
      try {
        const result = await app.dispatch({ action: 'restoreFirstNote', ...restore,
          requestId: `restore-first:${restore.noteId}:${Date.now()}:${++restoreSequence}` });
        if (result.status !== 'saved') await api.views.dialogs?.showMessageBox(restoreError(result.code));
      } catch (error) {
        if (!stopped) await api.views.dialogs?.showMessageBox(restoreError((error as { code?: string }).code));
      }
    }).catch(() => {}).finally(() => notices.delete(key));
  } });
  await app.initialize();
  const initial = await app.snapshot();
  const t = createTranslator(resolveLanguage(initial.preferences.language, initial.systemLocale || Intl.DateTimeFormat().resolvedOptions().locale));
  panel = new PanelController(api, app);
  await panel.initialize();
  const disposables: { dispose?(): void }[] = [];
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const changedNotes = new Set<string>();
  let fullRefresh = false;
  const refresh = (event?: { id?: string; noteId?: string }) => {
    if (stopped) return;
    const id = event?.id || event?.noteId;
    if (id) changedNotes.add(id); else fullRefresh = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const noteIds = fullRefresh ? undefined : [...changedNotes];
      changedNotes.clear(); fullRefresh = false;
      void app.dispatch({ requestId: `host-refresh:${Date.now()}`, action: 'refresh', noteIds })
        .catch(error => console.warn('Journey refresh failed', error?.code || error?.name));
    }, 350);
  };
  if (api.workspace?.onNoteChange) {
    const d = await api.workspace.onNoteChange(refresh); if (d) disposables.push(d);
  }
  if (api.workspace?.onSyncComplete) {
    const d = await api.workspace.onSyncComplete(() => refresh()); if (d) disposables.push(d);
  }
  if (api.workspace?.onNoteSelectionChange) {
    const d = await api.workspace.onNoteSelectionChange(async event => {
      try {
        const ids = event?.value;
        if (ids?.length) { for (const id of ids) refresh({ id }); }
        else {
          const selected = await api.workspace?.selectedNote?.();
          if (selected?.id) refresh({ id: selected.id });
        }
      } catch (error) { console.warn('Journey selection refresh failed', (error as Error)?.name); }
    });
    if (d) disposables.push(d);
  }
  const lastCommands = new Map<string, number>();
  const invokeSelected = async (action: 'complete' | 'abandonTask' | 'openNote' | 'setFields') => {
    const note = await api.workspace?.selectedNote?.();
    if (!note) { await panel?.show(); return; }
    const key = `${action}:${note.id}`; if (Date.now() - (lastCommands.get(key) || 0) < 1000) return; lastCommands.set(key, Date.now());
    const snapshot = await app.snapshot();
    const task = snapshot.tasks.find(t => t.noteId === note.id && !t.historical);
    if (!task) { await panel?.show(); return; }
    return app.dispatch({ requestId: `command:${action}:${Date.now()}`, action, noteId: task.noteId,
      ...(action === 'setFields' ? { pinned: !task.pinned } : {}),
      ...(action === 'complete' || action === 'abandonTask' ? { seriesId: task.seriesId, occurrenceId: task.occurrenceId } : {}) } as any);
  };
  const selectedEditor = async (type: 'series') => { const note = await api.workspace?.selectedNote?.(); if (note) await panel?.openEditor(type, note.id); else await panel?.show(); };
  const commands = [
    { name: 'journey.insertTemplateBlock', label: t('actions.insertTemplateBlock'), execute: async () => {
      const note = await api.workspace?.selectedNote?.();
      if (!note) { await panel?.show(); return; }
      if (typeof note.body !== 'string') throw new Error(t('error.templateBodyUnavailable'));
      if (parseArchiveBody(note.body)) return;
      const selection = await api.commands.execute('selectedText');
      const content = typeof selection === 'string' ? selection : '';
      const block = `\n${BODY_TEMPLATE_MARKERS.templateStart}\n${content}\n${BODY_TEMPLATE_MARKERS.templateEnd}\n`;
      await api.commands.execute('insertText', block);
    } },
    { name: 'journey.newTask', label: t('commands.newTask'), execute: async () => panel?.openEditor('new') },
    { name: 'journey.editSeries', label: t('commands.editSeries'), execute: async () => selectedEditor('series') },
    { name: 'journey.toggleTasks', label: t('panel.toggle'), execute: async () => panel?.toggle() },
    { name: 'journey.showTasks', label: t('commands.showTasks'), execute: async () => panel?.show() },
    { name: 'journey.refreshTasks', label: t('commands.refreshTasks'), execute: async () => { refresh(); return panel?.show(); } },
    { name: 'journey.completeSelected', label: t('commands.completeSelected'), execute: async () => invokeSelected('complete') },
    { name: 'journey.abandonSelected', label: t('commands.skipSelected'), execute: async () => invokeSelected('abandonTask') },
    { name: 'journey.pinSelected', label: t('commands.pinSelected'), execute: async () => invokeSelected('setFields') },
  ];
  let contextSequence = 0;
  const contextCommands = [
    ...([0, 1, 7, null] as const).map(offset => ({
      name: `journey.date${offset === null ? 'Clear' : offset}`,
      label: `Journey Tasks: ${offset === null ? t('menu.clearDate') : t('commands.setDate', { date: t(offset === 0 ? 'view.today' : offset === 1 ? 'view.tomorrow' : 'menu.nextWeek') })}`,
      execute: async (noteIds?: string[]) => {
        const ids = noteIds ?? [(await api.workspace?.selectedNote?.())?.id].filter((id): id is string => !!id);
        if (!ids.length) return;
        await app.dispatch({ requestId: `context-refresh:${Date.now()}:${++contextSequence}`, action: 'refresh', noteIds: ids });
        const snapshot = await app.snapshot();
        const locale = resolveLanguage(snapshot.preferences.language, snapshot.systemLocale);
        const failures: string[] = [];
        let saved = 0, skipped = 0;
        for (const noteId of new Set(ids)) {
          const task = snapshot.tasks.find(task => task.noteId === noteId && !task.historical);
          if (!task || task.completedAt) { skipped++; continue; }
          try {
            const zone = task.schedule.kind === 'none' ? Intl.DateTimeFormat().resolvedOptions().timeZone : task.schedule.zone;
            const date = addDays(timezoneAdapter.localDate(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone), offset ?? 0);
            const schedule = offset === null ? { kind: 'none' as const } : task.schedule.kind === 'timed'
              ? { kind: 'timed' as const, zone, ...resolveZonedTime(date, task.schedule.time, zone) }
              : { kind: 'allDay' as const, date, zone };
            const result = await app.dispatch({ requestId: `context-date:${Date.now()}:${++contextSequence}`, action: 'changeDate', noteId, schedule });
            if (result.status === 'saved') saved++;
            else failures.push(`${task.title}: ${translateMessage(result.message || result.code || 'error.commandFailed', locale, result.code)}`);
          } catch (error) {
            failures.push(`${task.title}: ${translateMessage((error as Error).message, locale, (error as { code?: string }).code)}`);
          }
        }
        if (failures.length || skipped) {
          const translate = createTranslator(locale);
          await api.views.dialogs?.showMessageBox([translate('commands.dateSummary', { saved, unchanged: skipped, failed: failures.length }), ...failures].join('\n'));
        }
      },
    })),
    { name: 'journey.openSelectedTask', label: `Journey Tasks: ${t('commands.openSelectedTask')}`, execute: async (noteIds?: string[]) => {
      const noteId = noteIds?.[0] ?? (await api.workspace?.selectedNote?.())?.id;
      if (!noteId) return panel?.show();
      await app.dispatch({ requestId: `context-open:${Date.now()}:${++contextSequence}`, action: 'refresh', noteIds: [noteId] });
      await panel?.openEditor('edit', noteId);
    } },
  ];
  let toggleIcon = 'fas fa-route';
  if (api.window?.loadChromeCssFile && api.plugins?.installationDir) {
    try {
      await api.window.loadChromeCssFile(`${await api.plugins.installationDir()}/host.css`);
      toggleIcon = 'journey-tasks-icon';
      await panel.enableCompact();
    } catch { /* Desktop enhancements remain optional on hosts that reject them. */ }
  }
  if (api.commands.register) {
    for (const c of commands) await api.commands.register({ ...c, iconName: c.name === 'journey.toggleTasks' ? toggleIcon : 'fas fa-calendar-check' });
    // Joplin omits disabled plugin commands from the native note-list menu.
    // noteIsTodo only covers single selection; batch handlers validate every target.
    for (const c of contextCommands) await api.commands.register({ ...c, enabledCondition: 'noteIsTodo || multipleNotesSelected', iconName: 'fas fa-calendar-check' });
  }
  if (api.views.toolbarButtons) {
    try { await api.views.toolbarButtons.create('journey.tasks.toggle', 'journey.toggleTasks', 'noteToolbar'); }
    catch { /* The native note toolbar is desktop-only. */ }
  }
  if (api.views.menus) { try { await api.views.menus.create('journey.tasks.menu', 'Journey Tasks', commands.map(c => ({ commandName: c.name })), 'tools'); } catch { /* Desktop-only menu; mobile has visible panel actions. */ } }
  if (api.views.menuItems) for (const command of contextCommands) {
    await api.views.menuItems.create(`${command.name}.context`, command.name, 'noteListContextMenu');
  }
  // A single next-boundary timer, not a recurring full-database polling loop.
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  const nextBoundary = () => {
    if (stopped) return;
    const d = new Date(); d.setHours(24, 0, 1, 0);
    boundaryTimer = setTimeout(() => { refresh(); nextBoundary(); }, Math.max(1000, d.getTime() - Date.now()));
  };
  nextBoundary();
  await panel.restoreStartup();
  return { app, panel, dispose() { stopped = true; if (refreshTimer) clearTimeout(refreshTimer); if (boundaryTimer) clearTimeout(boundaryTimer); for (const d of disposables) d.dispose?.(); app.dispose(); } };
}
