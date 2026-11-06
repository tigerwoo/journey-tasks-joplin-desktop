# README 全文核查

核查日期：2026-10-30。范围：`README.md`、`README.zh-CN.md` 全部章节、三张 Mermaid 流程图、截图、语言表及链接。依据为当前工作区源码；仅修改文档。

## 逐节核查依据

| README 内容 | 代码／资料依据 | 核查结果与修正 |
| --- | --- | --- |
| 标题、简介、版本、协议、桌面限制 | `src/manifest.json`、`package.json`、`LICENSE` | 版本均为 0.1.0，最低版本声明 3.3，平台仅 desktop，协议为 MIT。这些是配置声明，不能当作三个操作系统的实机验收结果。 |
| 软件截图 | `pictures/1.png` 至 `4.png`，`src/panel/TaskViews.tsx`、`TaskContextMenu.tsx` | 已查看四张图片，对应今日列表、全年、周视图、任务菜单；两份文档引用同一组图片。 |
| 下载、安装、更新、打开面板 | `.github/workflows/release.yml`、`scripts/build.mjs`、`src/bootstrap.ts`、Joplin 官方插件安装说明 | 安装文件名与 manifest ID、构建输出和上传命令一致。宿主菜单通过 `journey.showTasks` 打开面板。为下载入口补充 Releases 页面后备入口，不宣称安装包已经公开可下载。 |
| 新建任务与正文编辑 | `src/panel/App.tsx` 的 `TaskForm`、`createAndEdit`，`TaskApplication.createTask` | 保存后打开原生编辑器；新建表单先保存普通任务，之后才可配置重复。补充任务必须未完成才能转为重复。 |
| 快捷添加 | `src/panel/QuickAddTask.tsx` | 补充标题输入、Enter／加号提交、日期及笔记本偏好；只创建全天／无日期任务，提醒关闭。 |
| 已有原生待办 | `TaskApplication.collectTasks`、`importedTask`、`adoptSingle` | 补充初始日期来自原生 `todo_due`；无闹钟进入收集箱。普通笔记不自动转为待办；回收站、未解密和冲突笔记不作为普通导入任务显示。 |
| 正文与 Markdown 检查项 | `src/domain/bodyTemplate.ts`、`src/services/projectionExecutor.ts` | 完成投影只写原生任务字段，不扫描或重置 Markdown 检查项；归档模板按原样复制勾选状态。 |
| 任务列表范围 | `src/domain/dates.ts` 的 `viewRange`，`src/domain/projections.ts` | 今日、明天、从明天开始的七天、收集箱、所有与代码一致；最近七天也有只读预计项。逾期未完成项在日期列表和所有中保留。 |
| 列表分类、标签、排序、置顶 | `src/panel/App.tsx`、`TaskViews.tsx`、`viewModel.ts` | 删除“面板可按笔记本／标签筛选”的暗示：后端有查询参数，但当前面板无对应控件。标签在原生编辑器管理，列表支持时间／笔记本分组和升降序，置顶不越过所选视图范围。 |
| 日历、时区与逾期 | `src/domain/dates.ts`、`src/panel/TaskViews.tsx`、`calendarDisplay.tsx` | 确认周日开始、月周号／日期／年月份下钻；定时任务按设备时区显示，全天日期不换算。补充定时与全天逾期边界；农历显示只换标签，网格仍为公历。 |
| 任务菜单与批量操作 | `src/panel/TaskContextMenu.tsx`、`App.runMenuCommands` | 补充清除普通任务日期、完成／历史日期锁定、快捷日期保留时间、自选日期统一时间。确认多选键、取消选择和部分失败停止逻辑。历史周期及预计项不参与原生笔记多选菜单。 |
| 删除与停止重复 | `TaskApplication.executeCommand` 的 `deleteNativeTask`、`deleteTask`，`src/domain/series.ts` | 修正遗漏：从任务菜单删除重复笔记会先停止其系列，再将选中笔记送入回收站；其他周期保留。结束重复保留笔记和记录，停止预计、推进并取消本期原生提醒。 |
| 系列笔记本与恢复 | `TaskApplication.revise`、`finishSeriesMove`、`refreshInternal` | 显式操作系列笔记本才归拢首篇、当前和历史；包含散落笔记，略过回收站；本机恢复记录支持刷新／启动继续。单独移动当前笔记不改变系列生成位置。 |
| 重复规则、范围、结束条件 | `src/domain/recurrence.ts`、`src/adapters/calendar/lunarAdapter.ts`、`App.RuleFields` | 补充农历公历范围 1901-01-01 至 2099-12-31 及宿主日历能力要求；计数含首期、结束日期含当天；月末回退、第 5 个星期越界回退、年度闰月不存在时取普通月。工作日不包含调休规则。 |
| 本期日期与规则起算日期 | `src/domain/transitions.ts` 的 `ruleRevisionSchedule`，`App.SeriesEditor`、`TaskApplication.changeTaskDate` | 修正原说明：修改规则或起算日不会自动改本期；本期日期需要明确编辑，任务菜单改期为执行覆盖，不改原规则位置。 |
| 持续／归档模式 | `src/domain/transitions.ts` 的 `planAdvance`，`TaskApplication.advanceIfNeeded` | 持续复用载体，归档另建笔记；模式在下一次推进使用。正文既有记录不因周期处理被重写。 |
| 归档模板、初始化、引用限制 | `src/domain/bodyTemplate.ts`、`src/adapters/joplin/templateRepository.ts`、`TaskApplication.prepareArchiveSource` | 确认可选模板、标记解析、首篇一次性执行副本、不复制区外记录、损坏拒绝。补清保存／生成时拒绝图片、媒体与附件资源；资料笔记链接需要可读、未删除、无冲突。宿主插入命令可包装选区，面板按钮向首篇插入空模板。 |
| 系列改名 | `TaskApplication.syncSeriesTitle`、`seriesTitle` | 确认覆盖首篇、当前、历史、撤回后继、展示与未来标题；正文、日期、状态不变。不可用笔记报告待更新数量，刷新重试，不恢复被删除笔记。 |
| 核心原则与第一张流程图 | `TaskApplication.assertNotFuture`、`recordPeriodResolution`、`abandonTask`、`changeTaskDate` | 未来按任务保存时区的日期限制，今天无需等到时钟时刻，无日期普通任务可处理。改期后重新判断有无日期；删除节点补齐“停止系列”。 |
| 重复推进与第二张流程图 | `src/domain/transitions.ts` 的 `nextPeriodBasis`、`planAdvance`，`src/domain/series.ts` 的 `canAdvance`，`TaskApplication.advanceIfNeeded` | 确认本期处理才推进一次、按计划逐期追赶／按处理日期计算、结束条件、持续／归档、已推进不重复。流程补齐保留后继不可用时停止重试，以及模板来源、引用与目标笔记本校验。 |
| 撤销与第三张流程图 | `TaskApplication.reopenCycle`，`src/domain/series.ts` 的 `RewindAdvance` 归约，`src/services/reminderService.ts` | 最近推进撤回后继并保留其笔记；更早记录只改结果不移除推进边。生成失败尚无推进边时只重开本期。匹配保留后继被删除时拒绝替代创建。 |
| 原生完成、离线日期检查 | `TaskApplication.detectExternalSeriesChanges`、`reconcileSingle`、`savePendingCompletion` | 受管理任务用原生实际完成时间检查未来限制；运行时发现后纠正。未运行无法即时纠正。持续共享笔记的原生复选框对应最新周期。 |
| 放弃记录展示 | `src/panel/TaskViews.tsx`、`TaskHistory.tsx` | 删除错误的“列表和日历显示专用放弃标识”承诺；列表显示为已处理，日志中的 `history.skipped` 区分放弃结果。 |
| 任务日志 | `src/services/taskHistory.ts`、`src/panel/TaskHistory.tsx`、`App` 的 history 分支 | 确认可用创建时间、变更前后值、操作时间及重复周期合并。修正操作范围：重复周期有撤销／打开按钮，普通日志只读，普通任务通过列表取消完成。事件时间为设备时区，保存的计划值不换算。 |
| 提醒与稍后提醒 | `src/domain/reminders.ts`、`src/services/reminderService.ts`、`TaskApplication.validateReminder`、`detectExternalSeriesChanges` | 新建默认关闭，全天默认 09:00，定时取计划时刻，编辑页有十分钟稍后提醒；常规提醒需要日期。补充原生闹钟修改只覆盖已管理任务的提醒，不改计划。预计与非当前历史不安排额外提醒。 |
| 设置与语言 | `src/panel/SettingsPage.tsx`、`src/adapters/joplin/localIntentStore.ts`、`src/i18n/index.ts`、`registry.ts`、`src/bootstrap.ts` | 核对保存／取消、启动视图、输入日历、12／24 小时制、菜单重启更新。26 项语言与注册表一致。无法匹配语言回退 `en-US`；这与某个翻译键缺失时使用中文源字典兜底是两条不同逻辑。 |
| 同步、数据归属与冲突 | `src/adapters/joplin/repositories.ts`、`userDataStore.ts`、`localIntentStore.ts`，`TaskApplication.reconcileDuplicates` | 元数据附着原生笔记，系列首篇保留控制数据，模板在首篇正文；偏好和恢复本机独立。并发等价候选可归并，用户编辑或不等价推进会暂停，文档不承诺全局唯一物理笔记或通知。 |
| 清理与卸载 | `src/services/cleanupService.ts`、`src/panel/CleanupSettings.tsx`、`TaskApplication.dispatch` | 确认预览、RESET、保留正文／标签／完成状态、清除元数据及原生日期提醒、重置本机状态、立即进入收集箱。补充五分钟预览失效和未解密数据阻断；失败保持恢复保护，需重新预览。 |
| 常见问题 | 对应上述入口和错误码 | 移除不存在的笔记本／标签筛选操作；使用真实的“结束重复”“重试生成下一期”及英文文案。保留同步、解密、首篇恢复、模板修复、批量失败、系统通知权限排查。 |
| 赞助区与二维码 | `pictures/bmc_qr.png`、`src/panel/SettingsPage.tsx` | 二维码已解码为 `https://buymeacoffee.com/tigerwoo`，与两份 README 链接一致；未猜测赞助账号。 |
| HTML、相对链接及双语一致性 | 两份 README 和仓库文件 | 对照语义检查两份说明；检查语言表、版本、图片与本地链接、围栏及 Mermaid 节点引用。 |

## 验证结果与边界

- `npm test`：391 项，384 通过、7 跳过、0 失败。跳过项保留测试套件原有条件，不视为验收通过。
- 文档本地链接、图片引用、26 项语言表、manifest／package 版本一致性、HTML 配对、Mermaid 节点引用及 `git diff --check` 检查通过。
- 未修改程序，未构建、发布或操作真实用户任务；没有宣称已在 macOS／Windows／Linux 的真实 Joplin 中逐项验证，也没有宣称 README 已在 GitHub／Gitea 网页实际渲染验收。
- Joplin 的文件安装、重启和更新步骤已核对[官方插件使用说明](https://joplinapp.org/help/apps/plugins/)。
- 核查时 GitHub 公共 API 的最新版 Release 查询返回 404。无法据此区分仓库不可公开访问、没有可用正式 Release 等原因，因此未将下载链接视为已可用，README 保留 Releases 后备入口。未验证完整下载与安装链路。
