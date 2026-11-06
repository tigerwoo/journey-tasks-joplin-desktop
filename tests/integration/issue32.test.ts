import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskApplication } from '../../src/services/taskApplication';
import { MemoryJoplin } from '../support/memory-joplin';
import { DEFAULT_PLUGIN_ID } from '../../src/adapters/joplin/repositories';
import type { TaskInput, SeriesSummary } from '../../src/services/applicationTypes';
import type { DatedSchedule, TaskMode } from '../../src/shared/models';
const date = (value: string): DatedSchedule => ({ kind: 'allDay', date: value, zone: 'Asia/Shanghai' });
function setup() {
  const host = new MemoryJoplin(); host.namespace = DEFAULT_PLUGIN_ID; host.notebooks.set('book', { id:'book', title:'Book' });
  let clock = Date.parse('2026-10-28T04:00:00Z'), seq = 0;
  const options = { now: () => clock, randomId: () => String(++seq).padStart(32,'0') };
  const makeApp = () => new TaskApplication(host, options), app = makeApp();
  const input = (mode: TaskMode = 'archive'): TaskInput => ({ title:'旧名称', body:'正文不得改写', notebookId:'book', schedule:date('2026-10-26'), mode,
    recurrence:{calendar:'gregorian',frequency:'weekly',weekdays:[1],interval:1,basis:'scheduled',end:{kind:'never'}} });
  return { host, app, makeApp, input, day: (value: string) => {clock=Date.parse(value+'T04:00:00Z');} };
}
const current = (s: SeriesSummary) => s.occurrences.find(o => o.occurrenceId===s.activeOccurrenceId)!;
for (const entry of ['create','convert'] as const) for (const mode of ['archive','continuous'] as const) test(`${entry}/${mode}: renamed, backdated and abandoned periods keep dates after edits and restart`, async () => {
  const {host,app,input,makeApp}=setup();await app.initialize();
  let made;
  if(entry==='create') made=await app.dispatch({action:'createTask',requestId:'create',input:input(mode)});
  else {
    host.seedNote({id:'existing',parent_id:'book',title:'旧名称',body:'正文不得改写'});
    await app.dispatch({action:'refresh',requestId:'discover'});
    made=await app.dispatch({action:'editTask',requestId:'enable',noteId:'existing',patch:{schedule:input().schedule,recurrence:input().recurrence,mode}});
  }
  assert.equal(made.status,'saved',made.message);
  await app.dispatch({action:'complete',requestId:'complete-first',seriesId:made.seriesId});
  let series=(await app.snapshot()).series[0]!, b=current(series);
  assert.equal(b.scheduled.date,'2026-11-02');
  const bBody=host.notes.get(b.carrierNoteId)!.body;
  const renamed=await app.dispatch({action:'editTask',requestId:'rename',noteId:b.carrierNoteId,patch:{title:'新名称',reminder:{enabled:false}}});
  assert.equal(renamed.status,'saved',renamed.message);
  for(const note of host.notes.values()) assert.equal(note.title,'新名称');
  assert.equal(host.notes.get(b.carrierNoteId)!.body,bBody);
  series=(await app.snapshot()).series[0]!;
  // Backdate this occurrence independently; the series anchor must stay after history.
  const revised=await app.dispatch({action:'reviseSeries',requestId:'backdate',seriesId:made.seriesId!,revisionId:series.definition!.revisionId,definition:series.definition!,currentSchedule:date('2026-10-12')});
  assert.equal(revised.status,'saved',revised.message);
  for(const modeNow of ['continuous','archive'] as const) {
    series=(await app.snapshot()).series[0]!;
    await app.dispatch({action:'switchMode',requestId:'mode-'+modeNow,seriesId:made.seriesId!,revisionId:series.definition!.revisionId,mode:modeNow});
    assert.equal(current((await app.snapshot()).series[0]!).deferred?.date,'2026-10-12');
  }
  await app.dispatch({action:'editTask',requestId:'same-reminder',noteId:b.carrierNoteId,patch:{title:'新名称',reminder:{enabled:false}}});
  assert.equal(current((await app.snapshot()).series[0]!).deferred?.date,'2026-10-12');
  const abandoned=await app.dispatch({action:'abandonTask',requestId:'abandon',noteId:b.carrierNoteId});assert.equal(abandoned.status,'saved',abandoned.message);
  series=(await app.snapshot()).series[0]!;
  assert.equal(series.occurrences.find(o=>o.occurrenceId===b.occurrenceId)!.deferred?.date,'2026-10-12');
  assert.equal(series.occurrences.find(o=>o.occurrenceId===b.occurrenceId)!.resolution,'skipped');
  assert.equal(current(series).scheduled.date,'2026-11-09');
  assert.equal(series.anchorNoteId,made.noteId);
  const restarted=makeApp();await restarted.initialize();
  const after=await restarted.snapshot({view:'month',date:'2026-10-12',showCompleted:true});
  assert.equal(after.series[0]!.title,'新名称');
  assert.ok(after.items.some(i=>i.date==='2026-10-12'&&i.completed&&i.resolution==='skipped'));
  assert.equal(current(after.series[0]!).scheduled.date,'2026-11-09');
  assert.equal(host.notes.get(b.carrierNoteId)!.body,bBody);
});
test('planned catch-up advances exactly one week per action, completion-based rule uses handling date', async () => {
  for (const basis of ['scheduled','completed'] as const) {
    const {app,input}=setup();await app.initialize();
    const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12'),recurrence:{...input().recurrence!,frequency:'daily',weekdays:undefined,interval:7,basis}}});
    await app.dispatch({action:'abandonTask',requestId:'skip',noteId:made.noteId!});
    let series=(await app.snapshot()).series[0]!;
    assert.equal(current(series).scheduled.date,basis==='scheduled'?'2026-10-19':'2026-11-04');
    if(basis==='scheduled') {
      await app.dispatch({action:'complete',requestId:'done-19',seriesId:made.seriesId});
      assert.equal(current((await app.snapshot()).series[0]!).scheduled.date,'2026-10-26');
      await app.dispatch({action:'complete',requestId:'done-26',seriesId:made.seriesId});
      assert.equal(current((await app.snapshot()).series[0]!).scheduled.date,'2026-11-02');
      assert.equal((await app.dispatch({action:'complete',requestId:'future',seriesId:made.seriesId})).code,'FUTURE_TASK');
    }
  }
});
test('continuous history appears as separate logical periods without native reminder leakage', async () => {
  const {app,input,host}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input('continuous'),schedule:date('2026-10-12'),reminder:{enabled:true}}});
  await app.dispatch({action:'abandonTask',requestId:'abandon',noteId:made.noteId!});
  await app.dispatch({action:'complete',requestId:'complete',seriesId:made.seriesId});
  const s=await app.snapshot({view:'month',date:'2026-10-12',showCompleted:true});
  assert.deepEqual(s.items.filter(i=>i.kind==='actual').map(i=>i.date),['2026-10-12','2026-10-19','2026-10-26']);
  assert.equal(s.items.find(i=>i.date==='2026-10-12')!.resolution,'skipped');
  assert.ok(s.items.filter(i=>i.historical).every(i=>!i.reminderAt));
  assert.equal(host.notes.size,1);
});
test('ordinary abandonment remains distinguishable after restart and can be reopened', async () => {
  const {app,makeApp,input}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),recurrence:undefined}});
  await app.dispatch({action:'abandonTask',requestId:'abandon',noteId:made.noteId!});
  const restarted=makeApp();await restarted.initialize();
  assert.equal((await restarted.snapshot({view:'all',showCompleted:true})).items[0]!.resolution,'skipped');
  await restarted.dispatch({action:'reopen',requestId:'reopen',noteId:made.noteId!});
  assert.equal((await restarted.snapshot()).tasks[0]!.resolution,'open');
});
test('rename covers intermediate and withdrawn notes, partial failure is reported and retried without touching bodies', async () => {
  const {app,input,host}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12')}});
  const a=(await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({action:'complete',requestId:'a',seriesId:made.seriesId});
  const b=current((await app.snapshot()).series[0]!);
  await host.data.put(['notes',b.carrierNoteId],{}, {body:'用户保留的中间记录'});
  await app.dispatch({action:'reopen',requestId:'undo-a',seriesId:made.seriesId,occurrenceId:a});
  host.failNext('put','notes/'+b.carrierNoteId);
  await app.dispatch({action:'editTask',requestId:'rename',noteId:made.noteId!,patch:{title:'统一名称'}});
  assert.ok((await app.snapshot()).diagnostics.some(d=>d.code==='SERIES_RENAME_PENDING'));
  await app.dispatch({action:'refresh',requestId:'retry'});
  assert.ok([...host.notes.values()].every(n=>n.title==='统一名称'));
  assert.equal(host.notes.get(b.carrierNoteId)!.body,'用户保留的中间记录');
  await app.dispatch({action:'complete',requestId:'redo',seriesId:made.seriesId,occurrenceId:a});
  assert.equal(host.notes.size,2);
  assert.equal(host.notes.get(b.carrierNoteId)!.body,'用户保留的中间记录');
});
test('archive to continuous preserves first anchor; a missing first note blocks generation until restored', async () => {
  const {app,input,host}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12')}});
  await app.dispatch({action:'complete',requestId:'first',seriesId:made.seriesId});
  let s=(await app.snapshot()).series[0]!;
  await app.dispatch({action:'switchMode',requestId:'mode',seriesId:made.seriesId!,revisionId:s.definition!.revisionId,mode:'continuous'});
  await app.dispatch({action:'complete',requestId:'second',seriesId:made.seriesId});
  s=(await app.snapshot()).series[0]!;assert.equal(s.anchorNoteId,made.noteId);
  const root=structuredClone(host.notes.get(made.noteId!)!);host.notes.delete(made.noteId!);
  await app.dispatch({action:'refresh',requestId:'missing'});
  assert.equal((await app.snapshot()).series.length,0);
  assert.equal(host.notes.size,1);
  host.notes.set(made.noteId!,root);await app.dispatch({action:'refresh',requestId:'restore'});
  assert.equal((await app.snapshot()).series[0]!.anchorNoteId,made.noteId);
});
test('legacy transferred journal returns to its original first note without rewriting content', async () => {
  const {app,input,host,makeApp}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12')}});
  await app.dispatch({action:'complete',requestId:'first',seriesId:made.seriesId});
  const b=current((await app.snapshot()).series[0]!);
  await app.journal.reanchor(made.seriesId!,b.carrierNoteId,'legacy-transfer');
  const bodies=new Map([...host.notes].map(([id,n])=>[id,n.body]));
  const restarted=makeApp();await restarted.initialize();
  assert.equal((await restarted.snapshot()).series[0]!.anchorNoteId,made.noteId);
  for(const [id,body]of bodies)assert.equal(host.notes.get(id)!.body,body);
  await restarted.dispatch({action:'complete',requestId:'second',seriesId:made.seriesId});
  assert.equal((await restarted.snapshot()).series[0]!.anchorNoteId,made.noteId);
});
test('legacy transfer with missing original first note pauses instead of silently selecting the transferred carrier', async () => {
  const {app,input,host,makeApp}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12')}});
  await app.dispatch({action:'complete',requestId:'first',seriesId:made.seriesId});
  const b=current((await app.snapshot()).series[0]!);
  await app.journal.reanchor(made.seriesId!,b.carrierNoteId,'legacy-transfer');host.notes.delete(made.noteId!);
  const restarted=makeApp();await restarted.initialize();const s=await restarted.snapshot();
  assert.ok(s.diagnostics.some(d=>d.code==='CONTROL_READ_ONLY'));
  assert.ok(!s.series.some(x=>x.status==='active'));assert.equal(host.notes.size,1);
});
test('missing-anchor abandonment retains its outcome and imports it as abandoned after restoration', async () => {
  const {app,input,host,day}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12')}});
  await app.dispatch({action:'complete',requestId:'first',seriesId:made.seriesId});
  const b=current((await app.snapshot()).series[0]!),root=structuredClone(host.notes.get(made.noteId!)!);
  host.notes.delete(made.noteId!);await app.dispatch({action:'refresh',requestId:'missing'});
  const result=await app.dispatch({action:'abandonTask',requestId:'abandon',noteId:b.carrierNoteId});
  assert.equal(result.code,'ANCHOR_MISSING_PENDING');
  host.notes.set(made.noteId!,root);await app.dispatch({action:'refresh',requestId:'restored'});
  const retried=await app.dispatch({action:'retrySeries',requestId:'retry',seriesId:made.seriesId!});
  assert.equal(retried.status,'saved',retried.message);
  const s=(await app.snapshot()).series[0]!;
  assert.equal(s.occurrences.find(o=>o.occurrenceId===b.occurrenceId)!.resolution,'skipped');
});
test('legacy first-anchor consolidation resumes after a lost metadata acknowledgement', async () => {
  const {app,input,host,makeApp}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12')}});
  await app.dispatch({action:'complete',requestId:'first',seriesId:made.seriesId});
  const b=current((await app.snapshot()).series[0]!);
  await app.journal.reanchor(made.seriesId!,b.carrierNoteId,'legacy-transfer');
  const {stableHash}=await import('../../src/domain/identity');
  const {operationHeads}=await import('../../src/adapters/joplin/repositories');
  const note=(await app.gateway.getNote(b.carrierNoteId))!;
  const operations=await app.journal.operations(note,made.seriesId!);
  const payload={priority:'high' as const};
  await app.journal.append(b.carrierNoteId,{schemaVersion:1,opId:'legacy-extra',deviceId:'legacy',deviceSeq:1,seriesId:made.seriesId!,parents:operationHeads(operations),recordedAt:1,kind:'SetTaskFields',payload,payloadHash:stableHash(payload)},made.seriesId!);
  const set=host.data.userDataSet;let failed=false;
  host.data.userDataSet=async(type,id,key,value)=>{await set(type,id,key,value);if(!failed&&id===made.noteId&&(value as any)?.opId==='legacy-extra'){failed=true;throw new Error('lost first-anchor copy ack');}};
  const firstRestart=makeApp();await firstRestart.initialize();assert.equal(failed,true);
  const resumed=makeApp();await resumed.initialize();
  const s=await resumed.snapshot();assert.equal(s.series[0]!.anchorNoteId,made.noteId);assert.equal(s.series[0]!.status,'active');
  assert.ok(s.tasks.every(t=>t.priority==='high'));assert.equal(host.notes.get(made.noteId!)!.body,'正文不得改写');
});
test('series rename leaves unrelated same-title notes intact and does not overwrite later native title edits', async () => {
  const {app,input,host}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:input()});
  host.seedNote({id:'unrelated',parent_id:'book',title:'旧名称',body:'其他笔记'});
  await app.dispatch({action:'editTask',requestId:'rename',noteId:made.noteId!,patch:{title:'系列新名称'}});
  assert.equal(host.notes.get('unrelated')!.title,'旧名称');assert.equal(host.notes.get('unrelated')!.body,'其他笔记');
  await host.data.put(['notes',made.noteId!],{}, {title:'原生另行修改的标题'});
  await app.dispatch({action:'refresh',requestId:'refresh'});
  assert.equal(host.notes.get(made.noteId!)!.title,'原生另行修改的标题');
  assert.equal((await app.snapshot()).series[0]!.title,'系列新名称');
});
test('deleting an already renamed historical note does not create a false pending rename', async () => {
  const {app,input,host}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12')}});
  await app.dispatch({action:'complete',requestId:'a',seriesId:made.seriesId});
  const b=current((await app.snapshot()).series[0]!);
  await app.dispatch({action:'complete',requestId:'b',seriesId:made.seriesId});
  const c=current((await app.snapshot()).series[0]!);
  await app.dispatch({action:'editTask',requestId:'rename',noteId:c.carrierNoteId,patch:{title:'新名称'}});
  host.notes.delete(b.carrierNoteId);await app.dispatch({action:'refresh',requestId:'deleted-history'});
  assert.ok(!(await app.snapshot()).diagnostics.some(d=>d.code==='SERIES_RENAME_PENDING'));
});
test('ended continuous series history edits cannot reopen the latest shared native task', async () => {
  const {app,input,host}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input('continuous'),schedule:date('2026-10-12'),recurrence:{...input().recurrence!,end:{kind:'count',count:2}}}});
  const a=(await app.snapshot()).series[0]!.activeOccurrenceId!;
  await app.dispatch({action:'complete',requestId:'a',seriesId:made.seriesId});
  await app.dispatch({action:'complete',requestId:'b',seriesId:made.seriesId});
  const completed=host.notes.get(made.noteId!)!.todo_completed;
  assert.equal((await app.snapshot()).series[0]!.status,'ended');
  await app.dispatch({action:'reopen',requestId:'undo-a',seriesId:made.seriesId,occurrenceId:a});
  assert.equal(host.notes.get(made.noteId!)!.todo_completed,completed);
  assert.equal((await app.snapshot()).series[0]!.status,'ended');
  await app.dispatch({action:'complete',requestId:'redo-a',seriesId:made.seriesId,occurrenceId:a});
  assert.equal(host.notes.get(made.noteId!)!.todo_completed,completed);assert.equal((await app.snapshot()).series[0]!.status,'ended');
});
test('legacy consolidation validates domain operations before copying any logs to the first note', async () => {
  const {app,input,host,makeApp}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input(),schedule:date('2026-10-12')}});
  await app.dispatch({action:'complete',requestId:'first',seriesId:made.seriesId});
  const b=current((await app.snapshot()).series[0]!);
  await app.journal.reanchor(made.seriesId!,b.carrierNoteId,'legacy-transfer');
  const before=host.notes.get(made.noteId!)!.user_data;
  const {stableHash}=await import('../../src/domain/identity');
  const {operationHeads}=await import('../../src/adapters/joplin/repositories');
  const operations=await app.journal.operations((await app.gateway.getNote(b.carrierNoteId))!,made.seriesId!);
  const payload={title:''};
  await app.journal.append(b.carrierNoteId,{schemaVersion:1,opId:'invalid-title',deviceId:'legacy',deviceSeq:1,seriesId:made.seriesId!,parents:operationHeads(operations),recordedAt:1,kind:'SetTaskFields',payload,payloadHash:stableHash(payload)},made.seriesId!);
  const restarted=makeApp();await restarted.initialize();
  assert.equal(host.notes.get(made.noteId!)!.user_data,before);
  assert.ok((await restarted.snapshot()).diagnostics.some(d=>d.code==='CONTROL_READ_ONLY'));
});
test('shared-note history has its own menu and does not inherit current occurrence selection', async () => {
  const {app,input}=setup();await app.initialize();
  const made=await app.dispatch({action:'createTask',requestId:'create',input:{...input('continuous'),schedule:date('2026-10-12')}});
  await app.dispatch({action:'abandonTask',requestId:'abandon',noteId:made.noteId!});
  const s=await app.snapshot({view:'month',date:'2026-10-12',showCompleted:true});
  const items=s.items.filter(i=>i.kind==='actual');
  const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
  const {TaskList}=await import('../../src/panel/TaskViews');const {actualCount}=await import('../../src/panel/viewModel');
  const html=renderToStaticMarkup(createElement(TaskList,{items,busy:false,selectedIds:new Set([s.series[0]!.activeOccurrenceId!]),onSelect(){},onComplete(){},onMenu(){}}));
  assert.doesNotMatch(html,/task-abandoned|历史记录|已放弃/);assert.equal((html.match(/data-selected="true"/g)||[]).length,1);
  assert.equal((html.match(/class="more"/g)||[]).length,2);assert.equal(actualCount(items),2);
});
