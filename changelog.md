# Changelog

<!-- Prepend releases as ## vX.Y.Z. Keep English first, then Chinese, inside each version section. -->

## v0.1.1

### English

- Click a notebook name to see all its tasks, including subnotebooks and undated tasks. (#72)
- Add native task menus: Today, Tomorrow, +7 days, Clear date and Open settings. Bulk changes keep times and time zones, continue after failures and summarize results. Hide these menus for a single ordinary note. (#73)
- Open past recurring notes in their series log without errors; clear leftover menus and errors. Standardize command names and Chinese “Today” wording. (#73)
- Add a toolbar toggle and 32px collapsed mini bar; remember panel state and width after restart. (#75)
- Set a 400 × 240px minimum panel size and align list/calendar filters, keeping search and trailing controls together. (#77)
- Show all day/week tasks; month cells show three tasks with expand/collapse controls. (#80)
- Exclude trashed notebooks and notes from views and pickers; avoid full task reloads for notebook renames and reordering. (#81)
- Offer one deletion notice with a restore button for an active series’ first note; resume automatically after recovery without duplicate tasks. Ended series retain existing task dates and edits. (#82)
- Resume a manually stopped series only by saving its recurrence rules. (#83)
- Change the current execution date without shifting recurrence; safely recalculate rule changes and resume after relaxing exhausted limits. Reopening history leaves later tasks and counts intact. (#84)
- Add current-task recovery, confirmed whole-series deletion, conversion back to a to-do and a choice of occurrence for multi-device conflicts. (#84)
- Update all 26 languages and improve recovery-dialog text layout. (#82–#84)

### 中文

- 点击笔记本名称查看该笔记本及子笔记本的全部任务，包含无日期任务。 (#72)
- 新增原生任务菜单：今天、明天、七天后、清除日期及打开设置。批量改期保留时间和时区，失败后继续并汇总结果；单选普通笔记时隐藏这些入口。 (#73)
- 历史重复笔记直接打开系列日志，不再报错；清除残留菜单和错误，统一命令名称及中文“今天”用词。 (#73)
- 新增工具栏开关和 32px 折叠迷你栏，重启后记住面板状态和宽度。 (#75)
- 面板最小尺寸为 400 × 240px，统一列表/日历筛选布局，搜索框与尾部控件保持同行。 (#77)
- 日/周视图完整显示任务；月视图每天默认三条，可展开和收起。 (#80)
- 从视图和选择器排除回收站笔记本及笔记；笔记本改名、排序不再触发全量任务重载。 (#81)
- 有效系列的第一篇笔记删除时提示一次并提供恢复按钮，恢复后自动续接、不重复生成；已结束系列保留现有任务的日期和后续修改。 (#82)
- 手动停止的系列只能通过保存重复规则恢复。 (#83)
- 修改当前执行日期不改变重复节奏；修改规则安全重算，放宽耗尽限制后续接；重新打开历史期不影响后续任务及累计次数。 (#84)
- 新增当前任务恢复、确认删除整个系列、转回待办及多设备冲突时选择保留周期。 (#84)
- 更新全部 26 种语言，改善恢复对话框文字布局。 (#82–#84)
