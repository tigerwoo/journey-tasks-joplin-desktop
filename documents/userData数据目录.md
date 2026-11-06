# userData 数据目录

## 0.5.5：系列名称、结果与固定首篇

存储布局继续为 v3，领域操作 schemaVersion 继续为 1。

- `SetTaskFields.payload.title`：明确的系列改名，公共 reducer 选定其因果生效值；所有关联周期及新笔记使用同一名称。没有显式改名的旧系列由首篇标题提供兼容名称。
- `v3:title-applied:<hash(seriesId, renameOpId, noteId)>`：存于首篇，记录每篇笔记标题更新已完成；回执包含系列、目标笔记、名称和操作 ID。用于中断重试和避免覆盖用户后来在原生界面修改的标题；清理入口按当前命名空间删除。
- 普通任务的 `SinglePatch.patch.resolution` 保存 `open/completed/skipped`；旧 `skip` 日志继续表示放弃。缺首篇时的完成证据增加可选 `action`，导入后保留完成/放弃区别。仅有完成时间的旧普通任务不能推断原来的放弃类型。
- 周期计划由其终态之前已生效的修订恢复，名称/提醒修订不清除先前计划。已保存的推进边不因升级被静默改成另一条链。
- 固定首篇以 `CreateSeries.payload.first.carrierNoteId` 识别。旧转移提交和祖先记录保留，校验原始首篇、唯一已提交载体及操作 ID/哈希后复制日志回首篇；原始首篇缺失时等待恢复，不创建替代笔记。两端均有新增日志时需要显式重试合并。

本节替代下文早期关于持续模式迁移锚点的描述。


## 0.5.4 撤销日志补充

存储命名空间与格式版本沿用当前 v3。新增系列操作：

```ts
{ kind: 'RewindAdvance', payload: { targetOpIds: string[], occurrenceId: string, targetOpId: string } }
```

`targetOpIds` 指向需要撤回的推进操作，`occurrenceId` 指向恢复的周期，`targetOpId` 指向被撤销的完成/放弃终态。三者同一条日志持久化，避免崩溃后出现撤回推进但完成仍有效的中间状态。日志必须因果观察对应操作；后继并发推进则报告冲突。

后继的 `withdrawn` 状态由有效推进链可达性推导，不另存正文副本。保留已生成笔记及关联，退出真实任务与提醒，再次推进相同周期时优先复用。更早历史修正继续使用原有终态撤销，不取消推进链。

旧 `skip` 操作仍可读取，用户语义统一为放弃。旧模板初始化记录不再触发正文改写。原生提前完成纠正只更新原生完成字段，不写标题正文。

旧版本不理解新增撤销操作，请各设备统一更新后再使用。下文关于历史撤销永不回滚的描述已由本节替代。


当前构建0.5.1，持久化布局版本3；领域操作内部schemaVersion仍为1。直接重构，不迁移旧版测试数据。以下是键结构，不是磁盘目录或用户真实数据导出。

## 1. 总目录

规则、关联和操作日志位于Joplin对象userData的`io.journey.tasks`命名空间；任务正文和归档模板正文位于原生笔记body，无专用数据笔记本、控制笔记或模板笔记。

```text
普通任务自身（Note）
├─ v3:scope:<taskScopeId>                    单次任务身份
└─ v3:op:<taskScopeId>:<opId>                Single*日志

重复系列首篇任务自身（Note）
├─ v3:scope:<seriesId>                       系列根身份
├─ v3:op:<seriesId>:<opId>                   系列规则/动作/推进/投影日志
├─ v3:carrier:<seriesId>:<occurrenceId>       执行关联（根与执行身份可共存）
└─ v3:consumed:<hash>                        某期已消费推进机会的最小标记

归档后继任务自身（Note）
├─ v3:carrier:<seriesId>:<occurrenceId>       关联首篇与该周期，含最小计划快照
├─ v3:consumed:<hash>                        已正常推进，避免根缺失时重复完成
├─ v3:pending:<pendingId>                    根缺失时当前完成的待处理证据
├─ v3:pending-operation:<pendingId>          重试导入时固定的ActOccurrence操作
└─ v3:pending-imported:<pendingId>           该证据已恢复处理的回执
```

归档切回持续后的当前任务，还可包含：

```text
当前持续载体（仍是用户的一篇任务，不是辅助笔记）
├─ v3:scope:<seriesId>                       新锚点，含代数和祖先ID
├─ v3:op:<seriesId>:<opId>                   从旧锚点复制的不可变日志及之后的新操作
└─ v3:anchor-commit:<seriesId>:<transferId>   转移提交与日志指纹清单
```

同篇任务从普通转重复后，可以有单次作用域和系列作用域，日志必须分开归并。scope ID等分量按键构造器编码，不能靠任意冒号切分。实际键构造见repositories.ts；pending/consumed键见taskApplication.ts。

普通归档后继不复制整套规则、模板和系列日志。归档切回持续时，推进将完整规则和日志转移到当前载体，属于锚点转移而非创建辅助笔记。持续模式同篇可有多个历史carrier关联，使用carrierGeneration确定当前绑定。

## 2. 宿主封装

API通过`userDataSet(1,noteId,key,value)`保存键值，由宿主按插件ID封装；`userDataGet`读取业务值。原生`user_data`字段的示意布局：

```json
{
  "io.journey.tasks": {
    "v3:scope:系列ID": {
      "v": { "schemaVersion": 3, "role": "series", "seriesId": "系列ID", "rootNoteId": "首篇ID" },
      "t": 1700000000000
    }
  }
}
```

`v`为业务值，`t`为宿主合并时间戳，`d`可选为删除标记。插件不通过覆盖整个user_data来清理，不手工构造宿主封装。业务因果顺序由操作parents确定，不以宿主t或recordedAt代替。

## 3. 元数据与模板

### v3:scope:<scopeId>

`{schemaVersion:3,role:'single'|'series',seriesId,rootNoteId,anchorGeneration?,transferId?,ancestorNoteIds?}`。普通任务rootNoteId就是自身；归档初始是首篇，转移后的持续系列是当前载体。根可已完成或因跳过成为普通笔记，不因此失去系列身份；不再要求控制载体是额外非待办笔记。

### v3:carrier:<seriesId>:<occurrenceId>

```text
{schemaVersion:3,role:'carrier',seriesId,anchorNoteId,occurrenceId,creationHash,snapshot?}
snapshot = {schedule,priority,pinned,reminder,reminderOverride?,carrierGeneration?}
```

snapshot只保存当前周期最小展示/完成信息。首篇丢失时，仍能显示后继和说明来源，不会从最小快照凭空恢复整套规则。

### v3:anchor-commit:<seriesId>:<transferId>

`{schemaVersion:3,seriesId,transferId,rootNoteId,ancestorNoteIds,operationHashes}`。operationHashes 按操作ID列出完整操作的指纹，不含正文或模板。目标先写scope和日志，最后写commit；发现时校验清单完整才启用新锚点，以ancestorNoteIds排除旧锚点。目标提交后不要求旧首篇仍存在。

旧锚点不写模板快照，也没有额外redirect笔记。同步未完整、并发转移或同ID日志不一致时暂停，不能将读前检查当成跨端事务。旧锚点收到晚到日志时保留双方；显式重试只合并能校验的不可变操作，不覆盖用户正文。

### 模板不再使用 userData 键

0.4.1 不写入 `v3:template:*` 业务快照。首篇只用 `<!-- template:start -->` / `<!-- template:end -->` 定义模板原文，不加外层代码围栏、不围住执行正文；模板标题取原生笔记标题。每次归档生成前重新读取模板区并校验附件引用，只将来源笔记ID和内容指纹记入推进操作，不将正文写入日志。

模板外普通正文的任意勾选、过程数据和编辑均不进入模板。启用归档时，将用户定义的模板内容插到起始标记上方一次；后继仅有模板内容，不携带模板标记。持续模式无需模板。

### v3:template-init:<initializationIdHash> 及 :done

初始化元数据只保存 `{beforeHash,afterHash}`，完成回执保存 `{schemaVersion:3,afterHash}`，不保存模板正文。先记录哈希意图、再插入首期正文、最后确认；同次启用在写入后崩溃时，根据正文哈希恢复确认，避免重复插入。初始化期间用户编辑正文时停止并提示，不根据猜测覆盖。新建归档的正文在原生POST前已初始化，无需再插入。

### pending与consumed

- PendingCompletion：schemaVersion=3、pendingId、seriesId、anchorNoteId、noteId、occurrenceId、at、before（原生字段）、operationIdentity（opId/deviceId/deviceSeq）。先保存证据，再写原生完成状态。
- pending-operation：重试时写入一次完整ActOccurrence，稳定父依赖与操作身份，之后导入首篇日志。
- pending-imported：schemaVersion、pendingId、opId，用于防止再次导入。
- consumed：schemaVersion、seriesId、occurrenceId、terminalOpId等推进证据，防止根不可用时把正常历史当成未推进任务。

## 4. v3:op:<scopeId>:<opId>

领域日志内部保持schemaVersion=1。公共字段opId、deviceId、deviceSeq、parents、recordedAt、kind、payload、payloadHash；重复系列操作另含seriesId，普通SingleOperation通过所属scope关联。

每操作一个不可变键，写入同键不同内容会失败。规则和状态从日志重建，不另存一份全量数据库快照；模板正文不属于日志。以下领域类型继续使用。

## 5. 普通任务日志

| kind | payload |
| --- | --- |
| SingleCreate | `{ task: Task, initialNative: NativeFields }` |
| SinglePatch | `{ patch: Partial<Task>, clearReminderOverride?: boolean }`；只包含本次需要修改的字段 |
| SingleDelete | 显式删除为 `{ noteId, nativeUpdatedTime }`；原生转普通笔记脱管为 `{ detached: true, nativeUpdatedTime }` |
| SingleObserve | `{ beforeHash, afterHash }`；记录外部原生变化 |
| SingleProjectionIntent | `ProjectionPayload`；原生字段写入意图 |
| SingleProjectionReceipt | 同上，包含读回哈希 |

### Task

```text
Task
├─ taskId / noteId / title / notebookId
├─ tagIds: string[]
├─ schedule: Schedule
├─ completedAt: number                  0 表示未完成
├─ priority: high | medium | low | none
├─ pinned: boolean
├─ reminder: { enabled, allDayTime? }
├─ reminderOverride?: number            临时提醒覆盖，0 表示不提醒
├─ seriesId? / occurrenceId?            共享 Task 类型中的系列关联
├─ resolution?: open | completed | skipped
└─ managed?: boolean
```

Task 含初始标题等快照，但当前列表标题和所在笔记本以实际原生笔记为准；原生任务正文不存进 Task。

## 6. 重复系列日志

| kind | payload |
| --- | --- |
| CreateSeries | `{ definition: SeriesDefinition, first: Occurrence }` |
| ReviseSeries | `{ definition, current?: { occurrenceId, schedule, slotKey, clearDeferred? } }` |
| ResolveSeriesConflict | `{ definition, resolvedRevisionIds, current? }`；current 结构同上 |
| ActOccurrence | 下表所列周期动作 |
| SetTaskFields | `{ occurrenceId?, priority?, pinned? }` |
| Advance | `{ predecessorId, terminalOpId, next: Occurrence 或 null, ruleRevisionId, templateSourceNoteId?, templateContentHash?, candidateNoteId?, omittedFrom?, omittedUntil? }` |
| BindCarrier | `{ occurrenceId, noteId, creationHash, generation }` |
| ProjectionIntent / ProjectionReceipt | `ProjectionPayload` |
| StopOrDelete | `{ scope: stop 或 current 或 series 或 history, occurrenceId? }` |
| Restore | `{ targetOpIds: string[] }` |
| ObserveNative | `{ noteId, occurrenceId, beforeHash, afterHash }` |

### ActOccurrence 动作

| action | 其他字段 |
| --- | --- |
| complete / skip | occurrenceId、at |
| reopen | occurrenceId、targetOpId |
| defer | occurrenceId、schedule（有日期） |
| snooze | occurrenceId、until；时间戳设提醒覆盖，null 明确清除覆盖 |

### SeriesDefinition

```text
SeriesDefinition
├─ seriesId / revisionId
├─ parentRevisionIds: string[]
├─ rule: RecurrenceRule
├─ anchor: DatedSchedule                原始规则锚点
├─ priority / pinned
├─ modeForNext: continuous | archive
├─ reminder: { enabled, allDayTime? }
├─ sourceNotebookId
└─ sourceTagIds: string[]
```

### RecurrenceRule

| 字段 | 取值/作用 |
| --- | --- |
| calendar | gregorian / lunar |
| frequency | daily / weekly / monthly / yearly |
| interval | 间隔数 |
| basis | scheduled / completed |
| weekdays? | ISO 星期数组，周一=1，周日=7 |
| monthDay? / month? | 月内日序号、月份 |
| monthSelector? | day / lastDay / nthWeekday / lunarYearEnd |
| nth? / weekday? | 第几个星期、星期序号 |
| lunarLeap? | 是否锚定闰月 |
| end | `{kind:'never'}`、`{kind:'until',date}` 或 `{kind:'count',count}` |

### Occurrence

```text
Occurrence
├─ occurrenceId / seriesId / predecessorId?
├─ originatingRevisionId
├─ originSlotKey                        初始预计槽位身份
├─ suppressedSlotKeys: string[]         不应再单独显示的预计槽位
├─ scheduled: DatedSchedule
├─ deferred?: DatedSchedule             当前延期，不改原规则锚点
├─ resolution: open | completed | skipped
├─ resolvedAt? / terminalOpId?
├─ consumed: boolean                    是否已消费推进机会
├─ carrierNoteId / carrierGeneration
├─ mode: continuous | archive
└─ reminderOverride?: number
```

## 7. 日期、提醒与原生投影结构

```text
Schedule =
  { kind: 'none' }
  或 { kind: 'allDay', date, zone }
  或 { kind: 'timed', date, time, zone, instant, offsetMinutes?, adjustment? }

DatedSchedule = Schedule 中除 none 以外的两种
NativeFields = { is_todo, todo_due, todo_completed }

ProjectionPayload
├─ intentId / noteId / occurrenceId
├─ carrierGeneration / sourceOpId / phase
├─ before: NativeFields
├─ after: NativeFields
└─ readbackHash?                        写入回执携带
```

日期为 `YYYY-MM-DD`，钟点为本地时间字符串，zone 为 IANA 时区，instant/提醒/完成等时间戳使用毫秒。农历重复语义在 rule 中，Schedule 中仍保存转换后的公历日期及任务时区。

## 8. 本机设置与非userData内容

- 原生title/body/todo字段仍是任务本身数据。归档首篇只用短template标记界定未来复制内容，标记外就是可操作的普通正文；不注入执行标签或代码围栏。持续模式不追加勿删提示。
- 执行正文的附件仍是Joplin资源，用户自行保留；模板不复制附件。
- 语言、视图、设备身份、操作序号、分片outbox、request恢复和cleanup恢复状态位于本机settings，不同步。outbox新记录storageVersion=3，旧版本记录不重放。
- 创建未完成时，本机恢复记录可暂存创建正文；确认创建成功后移除create输入，已完成请求移除command，不以outbox长期保存模板正文。
- 清理记录先落本机，清理中断后禁止业务重放；清理成功清空outbox并重置本机偏好/身份，解除清理锁。
- 内存SeriesSnapshot、视图与未来预览仍由数据计算，不提前创建待办。

## 9. 清理与旧数据

清理入口只删本插件命名空间中的活动键，其他插件数据保留。通过userDataDelete写宿主删除标记，不能承诺同步墓碑、历史与备份被物理擦除。

旧版的meta/op:*、v2:*及数据笔记本标记不作为当前权威来源；仅清理功能识别明确旧控制/模板对象，预览后可删除。含其他内容的笔记本保留，不能按名称递归删除；不迁移旧业务数据。

## 10. 对应源码

- [repositories.ts](../src/adapters/joplin/repositories.ts)：新布局键、作用域隔离、根发现与重放。
- [templateRepository.ts](../src/adapters/joplin/templateRepository.ts)：首篇正文模板读取与引用校验。
- [taskApplication.ts](../src/services/taskApplication.ts)：周期关联、提示、pending/consumed及恢复。
- [cleanupService.ts](../src/services/cleanupService.ts)：影响预览、token与确认、作用域清理与中断重试。
- [localIntentStore.ts](../src/adapters/joplin/localIntentStore.ts)：本机设置、v3恢复与重置。
- [models.ts](../src/shared/models.ts)：领域结构。

0.3.1本机cleanup状态增加lastFailure（stage/itemId/code/detail），用于下次预览显示原始失败。该记录不写入笔记userData或同步目标。

## 0.5 视图及菜单数据说明

业务持久化布局仍为3，无需因界面升级清空任务。priority旧字段仍为序列化兼容保留，不用于界面输入、显示或排序。置顶沿用pinned，原生笔记本和标签只读展示或通过原生API移动，不新增分类数据库。

显示模式从九个view ID推导；defaultView/lastView与showCompleted、逾期开关均为本机settings偏好，不同步。原生/重复任务日期修改仍写对应计划日志，延期仅写当前defer；放弃使用现有complete动作，不新增隐藏模板快照。幂等放弃文字和首次时间戳标记在原生笔记正文末尾、template块外，每周期独立；这些执行记录随原生正文同步。移动改变parent_id，删除将当前原生笔记移入回收站；停止当前系列的操作日志仍按既有作用域保存。

0.5.1新增本机偏好overdueTomorrow:boolean，默认true，旧偏好按默认补齐；今日overdueToday和七天overdueSeven保持各自选择，不共享覆盖。已完成文字与PPT布局调整不修改业务日志或模板。
