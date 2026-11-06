# Issue #41：移动端兼容性与界面调研

调研日期：2026-10-29。项目版本：0.5.5。范围：issue 全部评论、两张附件截图、现有调用链、Joplin 官方文档及上游源码。未修改产品代码，未连接用户手机；下述结论区分源码验证、模拟验证和待真机验证。

## 结论

保留同一个插件和安装包，但工作范围应包含三个方面：宿主兼容层、面板生命周期与状态恢复、移动端界面。不能把这次问题只当作响应式布局改造。

优先修复保存链路，再验证重复与跨端数据，最后推进布局重构。现有 shared/domain/services/adapters 分层可以保留，不必整体迁移到 core/views。

## 截图与评论证据

- 20:16 截图：Joplin 圆角插件容器、右上关闭按钮、底部 Journey 标签；首页工具栏占据较多空间，快速输入栏及笔记本名称被截断。空状态不能用于判断有任务时的实际可用性。
- 20:46 截图：新建表单已填写标题和笔记本；重复复选框禁用，提示先保存再设置重复；错误为 `Error: Not Found (Calling api.joplin.data.get) (Calling api.joplin.data.get)`；底部同时有 Journey Tasks 和 Agenda 标签。
- 最新评论明确报告无法保存和设置重复。因此，必须先检查数据链路，不能只建议调整 CSS。

## 1. 保存失败：已发现可复现的错误处理缺陷

项目 `JoplinGateway.getNote()` 用 `isNotFound()` 把不存在的笔记转换为 null。`isNotFound()` 检查 status/statusCode/code/message，但未处理字符串错误。

Joplin 上游 `RemoteMessenger` 在传输异常时组装错误字符串，再用该字符串 reject；字符串会附带 `(Calling ...)`。移动端消息桥的这种行为与截图吻合。读取不存在的笔记本身是正常的创建前检查，不代表移动端不支持数据 API。

当前创建链路：

1. `TaskApplication.createTask()` 校验笔记本、日期等输入。
2. 生成稳定的目标 noteId，调用 `gateway.getNote(noteId)` 检查是否已经创建。
3. 后续才会记录创建阶段、调用 `ensureNote()`、POST 笔记及写入 userData。
4. 新 noteId 必然尚不存在；如果宿主返回字符串 Not Found，第二步会直接失败。

在不修改文件的诊断脚本中，将截图同型字符串传入现有代码：

```text
isNotFound(new Error(remoteError)) -> true
isNotFound(remoteError)            -> false
ensureNote()                      -> 抛出原字符串
POST calls                        -> 0
```

这是已在当前代码复现的缺陷，也是截图错误的高可信解释；尚未在用户安装的 Joplin 版本上复现完整流程，不能宣称已证明唯一根因。需要补充 Joplin/插件版本和调用阶段日志。

修复方向：在宿主适配边界统一规范化 unknown 异常，保留原始文本与可用状态码，并在具体的单笔记/资源读取上下文识别不存在。不要将所有 API 错误吞掉并当作空数据。同步审查依赖 `error.message`、`error.code`、`instanceof Error` 的其他分支。

## 2. 重复选项禁用：当前是产品流程，不是 API 能力探测

`App.tsx` 中重复复选框条件为 `disabled={!task || busy}`。新建表单没有 task，因此所有平台都要先保存，再在编辑阶段设置重复。

创建成功后 `createAndEdit()` 设置当前 task、切换编辑表单，再执行 openNote。保存被前述错误阻断，就无法进入允许设置重复的阶段。截图因此不能证明 userData 或重复算法在移动端不可用。

重复流程仍须独立验收：给现有任务设置重复、连续模式完成后推进、归档模式生成下一篇、跳过/撤销/改期、农历规则，以及桌面修改后手机同步。不应只修一次保存后就宣布移动端完全兼容。

## 3. API 与宿主兼容范围

| 能力 | 当前证据 | 实施要求 |
| --- | --- | --- |
| notes/folders/tags CRUD | 官方数据 API、上游共享实现均存在；不能把 Not Found 等同于接口不支持 | 验证缺失读取、指定 ID 创建、读回、修改、标签和删除 |
| userDataGet/Set/Delete | 上游 JoplinData 存在共享实现；项目将规则及日志存于笔记 userData | 真机验证读写、读回一致性及跨端同步，不另建手机存储格式 |
| settings | 项目用于本机偏好、设备身份和恢复记录 | 验证重启持久化、写入失败、恢复记录重放 |
| openNote | 当前移动端有对应命令 | 与保存结果分开呈现；打开失败不能诱导用户重复创建 |
| dismissPluginPanels | 当前移动端有独立命令 | 需要离开插件编辑正文时验证关闭面板与打开笔记的顺序、最低支持版本 |
| selectedText / insertText | 当前移动端编辑命令中有声明 | 依赖编辑器及当前笔记上下文；验证模板插入不会写入错误笔记 |
| menus | 官方标为桌面能力；项目当前捕获异常 | 通过宿主能力控制注册，手机保留面板内入口 |
| workspace 事件 | 项目订阅选择、笔记变化、同步完成 | onNoteChange 只覆盖当前选中笔记；补充恢复前台后的刷新，核查事件漏失 |
| Node/文件系统 | 项目主要走公开 API，未发现该创建链路依赖文件系统 | 保持现有设计，不为手机引入独立数据库或 localhost 服务 |
| 原生提醒 | 项目设置 todo_due，使用 Joplin 原生提醒 | 真机验证权限、时区、全天提醒和锁屏通知；后台 JS 定时器不作准点保证 |

平台识别和布局识别应分开：宿主版本/平台决定能力，容器实际宽度决定布局，输入方式决定触控策略。远程代理上属性“存在”或 `typeof === function` 不足以证明功能可执行。

## 4. 面板生命周期比普通响应式页面更复杂

当前上游 PluginPanelViewer 根据选中标签渲染单个 PluginUserWebView，并使用标签 ID 作为 key。切换 Journey/Agenda 会导致 WebView 替换；截图恰好出现这两个标签。因此根组件上方的 React 状态只能解决内部布局切换，不能保证跨宿主 WebView 重建保留草稿。

建议区分：

- 业务状态：由共享应用层及原有笔记/userData 承载。
- 会话状态：当前视图、日期、筛选、滚动位置，必要时由插件后台保留。
- 未提交草稿：通过带版本的消息保存到插件后台；如需进程退出后恢复，再使用本机持久化。不能仅依赖页面卸载回调。
- 提交状态：保存中、保存成功但打开失败、保存失败、结果待确认分别展示；重试保留请求身份，不能生成重复笔记。

前台恢复、宿主切换标签、应用切后台、进程回收、旋转及键盘开合需要分别验证。当前 App 已监听 visibilitychange/focus，但宿主 WebView 销毁后无法靠监听恢复旧内存；刷新事件也需要合并，避免频繁扫描。

## 5. 布局审查

现有窄屏 CSS 主要缩小头部控件，没有重构主体几何：列表最小宽 620px，日时间线 620px，周与月 640px，年视图 680px。它们由横向滚动容器承载；所以不能把“已有 media query”理解为完整适配。

| 页面/交互 | 手机建议 |
| --- | --- |
| 首页 | 紧凑标题、当前范围和新增入口；刷新/设置进入更多操作；筛选显示摘要 |
| 列表 | 标题主行、日期/笔记本次行、明确完成与更多按钮；不用整页横向滚动 |
| 快速新增 | 标题独占主要宽度；日期和笔记本进入展开选项，完整表单可继续编辑 |
| 新建/编辑 | 窄屏单列；常用字段优先、时区等进阶项折叠；保存按钮在键盘展开时仍可到达 |
| 日视图 | 全天与按时间分组的日程列表；不强制 620px 时间轴 |
| 周视图 | 紧凑周日期导航＋所选日任务，或按天分组列表；保留周范围语义 |
| 月视图 | 七列日期格内仅显示轻量标记/数量，任务列表置于下方 |
| 年视图 | 月份概览，点击进入月/日；不直接缩小十二张桌面月历 |
| 更多菜单 | 插件区域内的单层操作面板，明确返回；不用并排 hover 子菜单 |
| 多选 | 显式选择模式与批量操作栏；现有 Cmd/Ctrl 多选不能作为手机入口 |
| 设置/历史/冲突 | 单列、可滚动，保留恢复入口；长内容与翻译可换行 |
| 日期时间选择 | 触控尺寸、弹层边界和滚动定位统一验证；不能只依赖 title 提示 |

触控下部分按钮现在只有 32–38px 高，且有组件选择器覆盖通用 44px 规则。还需核对宽度、间距和透明点击区域。截图物理像素不等同于 WebView CSS 像素，断点不能根据图片宽度直接决定。

软键盘、返回键及滚动：项目将 html/body/宿主内容/root 多层限制高度和 overflow，编辑抽屉另有滚动。需要测试焦点控件可见、无双重滚动、弹层随可见区域变化、关闭日期弹层优先于关闭表单、未保存退出的处理。CSS 的 dvh 或安全区变量不能替代 Android/iOS 宿主实测。

## 6. 架构落地建议

保留 domain/services/adapters，扩展现有宿主网关处理错误、能力及导航。将 App 中查询/提交/选择状态提为共享控制逻辑，在其下渲染 WideLayout/CompactLayout。表单草稿从会被替换的布局组件中提取出来，再连接宿主会话恢复。

基础 token、输入控件和可复用内容组件共享；导航、日历呈现、菜单容器按空间拆分。不要同时挂载两套布局再用 display:none 隐藏，以免重复请求、焦点冲突和重复 ID。ResizeObserver 等宽度监听需避免键盘改变高度时无故切布局。

## 7. 验证与实施顺序

1. P0：错误规范化、缺失笔记读取与幂等创建；区分保存与导航结果。补字符串错误、写后超时、读回失败等有意义的回归场景。
2. P0：在移动宿主验证已有任务设置重复、两种重复模式、userData/原生字段和同步；再核定 manifest 的手机最低版本。目前声明 3.3 不等于已经完成该版本验收。
3. P1：草稿、标签切换和前后台恢复；补宿主级重建验证。
4. P1：首页、任务列表、新增/编辑和操作面板紧凑布局。
5. P2：日/周/月/年、设置、冲突恢复及清理页面；大数据性能与长时间使用验证。

验收矩阵覆盖容器宽 320/360/390/430/600/768 CSS px、手机横屏、桌面窄侧栏；触控/鼠标、大字体、中英文/RTL、明暗主题；软键盘开合、切换 Agenda、后台恢复、离线和跨端同步。

功能链路至少包括：新建→保存→打开原笔记→返回→设置重复→完成→推进下一期；保存超时重试不重复；未完成同步/缺失资源/删除锚点保留诊断与恢复能力。通知和系统返回键必须真机测试。

当前已执行源码审查和无文件变更的错误形态模拟；未运行移动宿主或真机端到端测试，也没有性能测量结果。官方移动网页构建可用于 API/消息桥的第一轮验证，但不能替代原生软键盘、后台、通知和 WebView 行为测试。iOS 还受仅推荐插件可安装的分发限制，不能把 Android 自定义 JPL 安装流程直接视为 iOS 验证方案。

## 参考来源

上游源码固定于本次读取的 dev 提交 `b48e75856d81152c32e71f21075e1c043d9ea922`，不代表用户手机版本：

- [官方 panels API](https://joplinapp.org/api/references/plugin_api/classes/joplinviewspanels.html)
- [官方 data API](https://joplinapp.org/api/references/plugin_api/classes/joplindata.html)
- [官方 commands API](https://joplinapp.org/api/references/plugin_api/classes/joplincommands.html)
- [官方移动插件调试流程](https://joplinapp.org/help/api/references/mobile_plugin_debugging/)
- [插件安装及 iOS 限制](https://joplinapp.org/help/apps/plugins/)
- [RemoteMessenger 错误传递](https://github.com/laurent22/joplin/blob/b48e75856d81152c32e71f21075e1c043d9ea922/packages/lib/utils/ipc/RemoteMessenger.ts#L190)
- [共享 JoplinData 实现](https://github.com/laurent22/joplin/blob/b48e75856d81152c32e71f21075e1c043d9ea922/packages/lib/services/plugins/api/JoplinData.ts)
- [移动插件面板标签及 WebView 生命周期](https://github.com/laurent22/joplin/blob/b48e75856d81152c32e71f21075e1c043d9ea922/packages/app-mobile/components/plugins/dialogs/PluginPanelViewer.tsx)
- [移动 WebView 宿主内容](https://github.com/laurent22/joplin/blob/b48e75856d81152c32e71f21075e1c043d9ea922/packages/app-mobile/components/plugins/dialogs/PluginUserWebView.tsx)
- [移动 openNote](https://github.com/laurent22/joplin/blob/b48e75856d81152c32e71f21075e1c043d9ea922/packages/app-mobile/commands/openNote.ts)
- [移动 dismissPluginPanels](https://github.com/laurent22/joplin/blob/b48e75856d81152c32e71f21075e1c043d9ea922/packages/app-mobile/commands/dismissPluginPanels.ts)
