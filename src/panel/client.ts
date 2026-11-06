import type { ActionResult, ApplicationCommand, ApplicationSnapshot, ViewQuery } from '../services/applicationTypes';
export interface PanelReply { ok: boolean; compact?: boolean; snapshot?: ApplicationSnapshot; result?: ActionResult; error?: string; code?: string; uiAction?: { type: 'new' | 'series' | 'edit'; noteId?: string } }
declare const webviewApi: { postMessage(message: unknown): Promise<PanelReply>; onMessage(handler: (message: { message?: any }) => void): void };
let seq = 0;
export class PanelClientError extends Error {
  constructor(public readonly code: string, detail?: string) { super(detail || code); this.name = 'PanelClientError'; }
}
export function requestId(): string { return `ui:${Date.now()}:${++seq}:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`; }
export async function querySnapshot(query: ViewQuery): Promise<ApplicationSnapshot> {
  const response = await webviewApi.postMessage({ protocolVersion: 1, requestId: requestId(), action: 'snapshot', query });
  if (!response.ok || !response.snapshot) throw new PanelClientError(response.code || 'error.readTasks', response.error);
  if (response.uiAction) window.dispatchEvent(new CustomEvent('journey-ui-action', { detail: response.uiAction }));
  return response.snapshot;
}
export async function sendCommand(command: ApplicationCommand): Promise<ActionResult> {
  const response = await webviewApi.postMessage({ protocolVersion: 1, requestId: command.requestId, action: 'command', command });
  if (!response.ok || !response.result) throw new PanelClientError(response.code || 'error.failed', response.error);
  if (response.result.status !== 'saved') throw new PanelClientError(response.result.code || 'error.stale', response.result.message || 'error.stale');
  return response.result;
}
export function listenInvalidation(handler: () => void, onAction?: (action: { type: 'new' | 'series' | 'edit'; noteId?: string }) => void, onRestore?: () => void): void {
  window.addEventListener('journey-ui-action', event => onAction?.((event as CustomEvent).detail));
  webviewApi.onMessage(event => {
    const message = event.message ?? event;
    if (message.type === 'invalidate') handler();
    if (message.type === 'restorePanel') onRestore?.();
  });
}

/** Native body edits and host refreshes are expected while configuring a template.
 * Retry only when the task and its series still match what the form was editing.
 */
export function canRetryTemplateSave(command: ApplicationCommand, before: ApplicationSnapshot, after: ApplicationSnapshot): boolean {
  const same = (left: unknown, right: unknown) => left !== undefined && JSON.stringify(left) === JSON.stringify(right);
  if ('noteId' in command && command.noteId) {
    const originals = before.tasks.filter(task => task.noteId === command.noteId);
    const currents = after.tasks.filter(task => task.noteId === command.noteId);
    if (!originals.length || !same(originals, currents)) return false;
    const original = originals.find(task => !task.historical) || originals[0];
    return !original?.seriesId || same(before.series.find(series => series.seriesId === original.seriesId), after.series.find(series => series.seriesId === original.seriesId));
  }
  if ('seriesId' in command && command.seriesId) {
    const original = before.series.find(series => series.seriesId === command.seriesId);
    const current = after.series.find(series => series.seriesId === command.seriesId);
    if (!same(original, current)) return false;
    return JSON.stringify(before.tasks.filter(task => task.seriesId === command.seriesId)) === JSON.stringify(after.tasks.filter(task => task.seriesId === command.seriesId));
  }
  return false;
}

export async function sendTemplateCommand(command: ApplicationCommand, snapshot: ApplicationSnapshot | undefined,
  query: ViewQuery, onSnapshot: (snapshot: ApplicationSnapshot) => void): Promise<ActionResult> {
  try { return await sendCommand(command); }
  catch (error) {
    if (!(error instanceof PanelClientError) || error.code !== 'STALE_SNAPSHOT' || !snapshot) throw error;
    const latest = await querySnapshot(query);
    onSnapshot(latest);
    if (!canRetryTemplateSave(command, snapshot, latest)) throw error;
    // STALE_SNAPSHOT is returned before any write. Keep the request identity for idempotency.
    return sendCommand({ ...command, expectedSnapshotVersion: latest.snapshotVersion });
  }
}

export async function reportIssue(): Promise<void> {
  const response = await webviewApi.postMessage({ protocolVersion: 1, requestId: requestId(), action: 'reportIssue' });
  if (!response.ok) throw new PanelClientError(response.code || 'error.failed', response.error);
}

export async function supportAuthor(): Promise<void> {
  const response = await webviewApi.postMessage({ protocolVersion: 1, requestId: requestId(), action: 'supportAuthor' });
  if (!response.ok) throw new PanelClientError(response.code || 'error.failed', response.error);
}

/** False asks the UI to use its content-only fallback on hosts without chrome CSS. */
export async function collapsePanel(): Promise<boolean> {
  const response = await webviewApi.postMessage({ protocolVersion: 1, requestId: requestId(), action: 'collapsePanel' });
  if (!response.ok) throw new PanelClientError(response.code || 'error.failed', response.error);
  return response.compact === true;
}
