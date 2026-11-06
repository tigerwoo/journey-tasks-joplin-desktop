import type { TaskLogEntry } from './taskHistory';
import type { CleanupPlan, CleanupResult } from './cleanupTypes';
import type { DatedSchedule, DomainConflict, NativeNote, Occurrence, Priority, RecurrenceRule, ReminderPolicy,
  Schedule, SeriesDefinition, Task, TaskMode, ViewKind, ViewSnapshot } from '../shared/models';
import type { NativeFolder, NativeTag } from '../adapters/joplin/gateway';
import type { ViewPreferences } from '../adapters/joplin/localIntentStore';
export type { CleanupPlan, CleanupResult } from './cleanupTypes';

export interface ViewQuery { notebookIds?: string[]; search?: string; view?: ViewKind; date?: string; deviceZone?: string; showCompleted?: boolean; notebookId?: string; tagId?: string }
export interface TaskInput {
  title: string;
  body?: string;
  notebookId: string;
  schedule: Schedule;
  priority?: Priority;
  pinned?: boolean;
  reminder?: ReminderPolicy;
  recurrence?: RecurrenceRule;
  mode?: TaskMode;
}
export interface SeriesSummary {
  seriesId: string;
  controlNoteId: string;
  title: string;
  status: 'active' | 'ended' | 'pausedConflict' | 'waiting';
  definition?: SeriesDefinition;
  revisionChoices: SeriesDefinition[];
  revisionIds: string[];
  advanceChoices?: { opId: string; date: string; noteId: string; title: string }[];
  activeOccurrenceId?: string;
  consumedCount: number;
  occurrences: Occurrence[];
  conflicts: DomainConflict[];
  warning?: string;
  warningCode?: string;
  anchorNoteId?: string;
  pendingCompletion?: boolean;
  resumeUnavailable?: boolean;
}
export interface ApplicationDiagnostic { code: string; message: string; seriesId?: string; noteId?: string }
export interface ApplicationSnapshot extends ViewSnapshot {
  taskLogs?: Record<string, TaskLogEntry[]>;
  snapshotVersion: number;
  now: number;
  deviceZone: string;
  systemLocale?: string;
  tasks: Task[];
  series: SeriesSummary[];
  folders: NativeFolder[];
  tags: NativeTag[];
  preferences: ViewPreferences;
  diagnostics: ApplicationDiagnostic[];
  loading: boolean;
}
export interface RestoreFirstTarget { noteId: string; seriesId: string; convert?: boolean }
interface CommandBase { requestId: string; expectedSnapshotVersion?: number }
export type ApplicationCommand = CommandBase & (
  | { action: 'createTask'; input: TaskInput }
  | { action: 'changeDate'; noteId: string; schedule: Schedule }
  | { action: 'abandonTask'; noteId: string }
  | { action: 'deleteNativeTask'; noteId: string; occurrenceId?: string }
  | { action: 'moveTask'; noteId: string; notebookId: string }
  | { action: 'editTask'; noteId: string; patch: Partial<Pick<TaskInput, 'title' | 'body' | 'notebookId' | 'schedule' | 'priority' | 'pinned' | 'reminder' | 'recurrence' | 'mode'>> }
  | { action: 'complete' | 'skip' | 'reopen'; noteId?: string; seriesId?: string; occurrenceId?: string }
  | { action: 'snooze'; noteId: string; until: number }
  | { action: 'reviseSeries'; seriesId: string; revisionId: string; definition: SeriesDefinition; currentSchedule?: DatedSchedule; moveSeries?: boolean }
  | { action: 'resolveConflict'; seriesId: string; definition: SeriesDefinition; revisionIds: string[]; currentSchedule?: DatedSchedule }
  | { action: 'switchMode'; seriesId: string; revisionId: string; mode: TaskMode }
  | { action: 'deleteTask'; noteId: string; seriesId?: string; scope?: 'stop' | 'history' }
  | { action: 'keepOccurrence'; seriesId: string; opId: string }
  | { action: 'dismissDetached'; seriesId: string; noteId: string }
  | ({ action: 'restoreFirstNote' } & RestoreFirstTarget)
  | { action: 'retrySeries'; seriesId: string; noteId?: string }
  | { action: 'setFields'; noteId: string; priority?: Priority; pinned?: boolean }
  | { action: 'openNote' | 'insertTemplateBlock'; noteId: string }
  | { action: 'adoptNativeDate'; noteId: string }
  | { action: 'savePreferences'; preferences: Partial<ViewPreferences> }
  | { action: 'previewCleanup' }
  | { action: 'executeCleanup'; token: string; confirmation: string }
  | { action: 'refresh'; noteIds?: string[]; checkChanges?: boolean }
);
export interface ActionResult {
  requestId: string;
  status: 'saved' | 'conflict' | 'error';
  snapshotVersion: number;
  noteId?: string;
  seriesId?: string;
  cleanupPlan?: CleanupPlan;
  cleanupResult?: CleanupResult;
  code?: string;
  message?: string;
}

export interface NativeObservation { note: NativeNote; signature: string }
