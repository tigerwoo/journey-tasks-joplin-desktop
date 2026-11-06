# Joplin 增强插件技术调研

调研日期：2026-10-23

本文整理 Joplin 增强插件在桌面、Android 和 iOS 上的可行性，以及使用 Rust 编译 WebAssembly（Wasm）复用核心逻辑的方案。结论依据官方文档和插件作者的项目说明；尚未编写验证原型，也未进行真机测试。

## 1. 核心结论

- 可以开发同时支持 Windows、macOS、Linux 和 Android 的 Joplin 插件。
- iOS、iPadOS 支持插件，但官方客户端仅允许安装 Joplin 的“推荐插件”。私人插件和普通新发布插件不能假定可以在 iOS 上直接安装。
- 可以采用 TypeScript 接入 Joplin，Rust 编译 Wasm 承担核心算法的架构。同一份 Wasm 有望跨端复用，但加载方式和运行兼容性仍需验证。
- Wasm 不会消除宿主 API、界面、权限、后台生命周期和插件分发渠道的差异，也不能绕过 iOS 的安装限制。
- 建议首期明确支持桌面与 Android，将 iOS 作为受分发渠道约束的兼容目标。

## 2. 平台支持与分发限制

| 平台 | 插件支持 | 对项目的影响 |
| --- | --- | --- |
| Windows、macOS、Linux | 支持插件目录安装与手动安装 `.jpl` | 可以开发、自用和分发 |
| Android | 支持插件目录安装与手动安装 `.jpl` | 可以验证并使用自行开发的插件；手动安装入口位于插件设置的高级设置中 |
| iOS、iPadOS | 支持插件，但仅允许安装推荐插件 | 技术兼容不等于能够安装；需要单独解决分发条件 |

来源：[Joplin 官方插件安装说明](https://joplinapp.org/help/apps/plugins/)。

### 2.1 iOS 的关键障碍

进入官方插件目录与成为“推荐插件”是两件事。官方推荐插件说明当前表示，没有开放的一般审核流程，现有推荐主要来自 Joplin 团队或经常贡献的开发者。因此，不能把“开发完成后申请推荐，即可在 iOS 使用”作为确定的交付路径。

使用 Rust 或 Wasm 不会改变这一限制。自行修改、构建或分发 iOS 客户端属于另一条工程路径，不属于普通插件开发范围，本文未验证该路径。

来源：[官方推荐插件政策](https://github.com/joplin/plugins/blob/master/readme/recommended.md)。

## 3. Joplin 的技术架构

| 部分 | 技术与职责 |
| --- | --- |
| 桌面应用 | Electron + React，后端运行在 Node.js |
| 移动应用 | React Native，应用后端使用 Hermes JavaScript 引擎 |
| 共享业务层 | 笔记模型、搜索、同步等服务 |
| 本地存储 | SQLite，保存笔记、设置和缓存等数据 |
| 同步服务 | 负责设备间数据同步，可使用 Joplin Server 等同步目标 |

应用的大量后端逻辑共享，界面与系统集成存在平台差异。

来源：[Joplin 官方架构说明](https://joplinapp.org/help/dev/spec/architecture/)。

### 3.1 插件运行模型

插件入口是 JavaScript；TypeScript 需要编译为 JavaScript 后交付。

- 桌面端通过独立的 Electron `BrowserWindow` 加载插件。
- 移动端插件运行涉及 WebView，通过消息桥与 React Native 宿主通信。
- 插件通过 Joplin API 访问宿主能力，不同平台的 API 支持范围存在差异。
- 编辑器、渲染器、面板等执行上下文之间需要消息通信，不能假设可以直接共享对象或函数。

移动应用后端使用 Hermes，并不能直接推导移动插件无法运行 Wasm；应检查实际承载插件的 WebView 环境。

来源：[插件系统架构](https://joplinapp.org/help/dev/spec/plugins/)。

### 3.2 平台声明

跨端插件应在 `manifest.json` 中声明：

```json
{
  "platforms": ["desktop", "mobile"]
}
```

这是 Manifest 字段片段，并非完整清单。还应根据实际使用的 API 设置 `app_min_version`，必要时通过 `app_min_version_mobile` 单独设置移动端最低版本。平台声明不会自动适配不兼容的 API，也不构成 iOS 安装许可。

来源：[Plugin Manifest 文档](https://joplinapp.org/help/api/references/plugin_manifest/)。

## 4. Rust + WebAssembly 的可行方案

推荐结构为“TypeScript 插件接入层 + Rust/Wasm 核心”。

```text
Joplin 桌面 / Android / iOS（受安装条件限制）
                    |
            TypeScript 插件接入层
             /          |          \
      Joplin API      插件界面      Rust/Wasm
      数据与事件      面板与编辑器    解析与计算
```

| 层 | 建议职责 |
| --- | --- |
| TypeScript | 插件启动、事件监听、Joplin API 调用、数据读写、网络访问、平台适配 |
| HTML/CSS/TypeScript | 面板、对话框、触摸交互、编辑器扩展 |
| Rust/Wasm | 文本解析、规则引擎、图算法、复杂计算、格式转换等纯逻辑 |

最终交付仍是包含 JavaScript、Wasm 与其他资源的 `.jpl` 插件包，而不是让 Joplin 直接加载 Rust 原生程序。

### 4.1 已有案例及证据边界

Harper 插件作者说明，其将 WebAssembly 语法检查引擎随插件打包，在桌面和 Android 上离线运行。这为“Joplin 插件中使用 Wasm”提供了实际案例。

作者同时说明仅测试了 Android。因此，该案例不能证明 iOS 已兼容，也不能替代本项目的加载、性能和真机测试。

来源：[Harper 插件项目说明](https://joplinapp.org/plugins/plugin/io.github.pmslava.harper/?from-tab=editor)。

### 4.2 Rust 编译目标

建议优先评估 `wasm32-unknown-unknown`，配合 `wasm-bindgen` 生成与 JavaScript 交互的绑定代码。

这个目标对宿主操作系统不作常规假设，不能把原生 Rust 程序直接照搬进去：`std::fs` 会返回错误，普通 `std::thread::spawn` 不可用。文件、网络和宿主操作应通过接入层提供，依赖的 Rust crate 也需检查 Wasm 兼容性。

不应默认 Joplin 内置 WASI 运行时；使用 WASI 目标需要另行解决运行时与宿主接口。

来源：[Rust 官方 Wasm 目标说明](https://doc.rust-lang.org/stable/rustc/platform-support/wasm32-unknown-unknown.html)、[wasm-bindgen 支持目标](https://rustwasm.github.io/docs/wasm-bindgen/reference/rust-targets.html)。

## 5. 跨端设计限制

### 5.1 API 与原生依赖

Joplin 插件 API 存在平台差异。官方文档指出不能随插件打包原生包，`joplin.require()` 暴露的特定原生库属于桌面能力。跨端核心不应依赖 Node 原生扩展或 Rust 原生动态库。

必须逐项核对功能需要的 API，并对桌面专用能力提供移动端方案，或明确限制功能范围。

来源：[Joplin API 入口与 require 说明](https://joplinapp.org/api/references/plugin_api/classes/joplin.html)。

### 5.2 界面与编辑器

桌面菜单、快捷键和宽屏面板需要为手机提供适合触摸的入口和布局。Markdown 编辑器扩展与富文本编辑器扩展应分别评估，不能假定一套扩展同时覆盖两种模式。

这些是本项目的设计与验证要求，并非已验证的功能支持清单。Harper 的项目说明也明确将其编辑器增强限定在 Markdown 编辑器。

### 5.3 生命周期与系统集成

涉及锁屏后持续处理、定时任务、系统级通知、文件监听或调用本地程序的功能，需要单独验证宿主提供的能力。Wasm 的计算可移植性无法保证这些功能跨端可用。

### 5.4 Wasm 加载与性能

原型需要验证：

- `.wasm` 是否完整打包，安装后是否能够离线加载。
- 不同执行上下文中的资源路径与 WebView 安全策略。
- 目标 Android System WebView、iOS WebView 与编译产物特性的兼容性。
- 初始化时间、插件体积、峰值内存、大笔记处理延迟。
- JS/Wasm 间字符串与数据复制的成本，以及消息桥通信开销。

建议先采用单线程设计、批量接口、增量处理和延迟加载。不要预设 Wasm 一定比 JavaScript 更快，也不要把多线程、SIMD 等高级特性作为首期的隐含前提。

## 6. 数据持久化与同步

插件运行在多端，不代表插件所有配置与本地文件会自动同步。建议区分以下数据：

| 数据 | 建议存储方式 |
| --- | --- |
| 笔记正文、附件 | 通过 Joplin API 管理，使用 Joplin 同步 |
| 与笔记关联的小型插件元数据 | 评估 `joplin.data.userDataSet()` |
| 需要同步的插件业务配置 | 根据数据模型选择 userData 或专用笔记，并设计冲突处理 |
| 可重建索引、缓存 | 保存在设备本地，通过宿主允许的接口访问 |

官方数据 API 说明 userData 会跨设备同步，并按时间戳合并；这不等同于复杂业务数据的自动无冲突合并。不要直接操作 Joplin 的 SQLite 数据库。

来源：[Joplin 数据 API](https://joplinapp.org/api/references/plugin_api/classes/joplindata.html)。

## 7. 选型建议

| 增强功能 | 建议路线 |
| --- | --- |
| 标签、模板、批量修改笔记、外部 API 集成、简单面板 | 优先 TypeScript，降低接入与维护成本 |
| 复杂解析、规则系统、图计算、复用已有 Rust 库 | TypeScript + Rust/Wasm |
| 大幅替换主界面、深度系统集成、持续后台服务 | 先验证插件 API 是否足够，可能需要修改客户端 |

Rust 的主要价值是算法复用、已有库复用和特定计算场景的性能潜力。仅为支持桌面与 Android，不必强制引入 Rust；TypeScript 本身就是 Joplin 的跨端插件开发路线。

## 8. 建议的最小验证原型

明确增强功能后，先用同一份 `.jpl` 在桌面和 Android 上完成以下链路：

1. 启动插件，注册可访问的操作入口。
2. 通过 Joplin API 读取一篇笔记。
3. 离线加载随包发布的 Rust/Wasm，执行一个小型文本处理函数。
4. 展示处理结果，由用户触发后写回测试笔记。
5. 保存笔记关联元数据，并验证跨设备同步。
6. 检查重启、切换笔记、大文本和处理失败时的行为。

移动端可先借助官方提供的移动应用 Web 构建提高调试效率，但它不能代替 Android 真机测试。iOS 则需要先明确可用的安装和分发条件，再做相应真机验证。

来源：[移动插件调试说明](https://joplinapp.org/help/api/references/mobile_plugin_debugging/)。

## 9. 尚待明确的项目需求

- 具体增强哪些功能：编辑、检索、知识组织、同步、附件处理或其他？
- 是否必须离线运行，是否允许调用外部服务？
- 是否需要处理整个笔记库，数据规模有多大？
- 是否必须支持富文本编辑器？
- iOS 是首期交付要求，还是后续兼容目标？
- 是否存在必须复用的 Rust 算法或库？

这些信息将决定插件 API 是否足够、是否值得引入 Wasm，以及首期支持范围。

## 10. 纯 TypeScript 与 Rust/Wasm 的性能及耗电比较

以下是依据运行机制给出的工程判断，不是本项目的实测结果。没有统一的加速倍数或省电比例；需要在目标设备、相同输入、相同输出和相同算法条件下比较。

### 10.1 比较对象

TypeScript 类型会在编译时擦除，因此这里的“纯 TS”指编译后的 JavaScript，与“JavaScript 接入层 + Rust 编译的 Wasm”比较。Rust/Wasm 不会移除 Joplin 的 Electron、WebView、JavaScript 引擎或界面框架。

来源：[TypeScript 官方文档](https://www.typescriptlang.org/docs/handbook/2/classes.html)。

| 维度 | 纯 TS/JS | Rust/Wasm |
| --- | --- | --- |
| 轻量事件、菜单、设置 | 接入直接，通常更合适 | 增加桥接和初始化工作，收益通常有限 |
| 大量数值运算、紧凑数据遍历 | 优化后的 JS/TypedArray 也可能很快 | 更有机会受益于编译优化和紧凑内存布局，需实测 |
| 文本、正则、JSON | 能直接使用引擎内建能力 | 需要考虑字符串编码、复制与库实现，不保证更快 |
| Joplin API、数据库、网络等待 | 宿主或 I/O 成为瓶颈 | 不会因为更换计算语言就直接加速等待部分 |
| 冷启动、首次调用 | 有 JS 解析、编译和初始化成本 | 有 Wasm 加载、编译、实例化和业务初始化成本；结果取决于包体、缓存及引擎 |
| 内存 | JS 对象和 GC 成本；也可使用 TypedArray | 可采用紧凑结构，但还存在 Wasm 内存、JS 对象和跨边界副本 |
| 输入交互流畅度 | 长同步任务会阻塞所属执行上下文 | 长同步 Wasm 调用也会阻塞所属执行上下文；不会自动成为后台任务 |
| 耗电 | 由执行频率、CPU、内存、I/O 等共同决定 | 可能因缩短计算省电，也可能因初始化、复制和更多工作量增加耗电 |

V8 的 Wasm 也采用分层编译，不能简单理解为“Rust 编译一次，设备上完全没有编译成本”。冷启动、首次迭代、稳定吞吐和长尾延迟应分别测量。

来源：[V8 Wasm 编译流程](https://v8.dev/docs/wasm-compilation-pipeline)、[WebKit JetStream 3 的生命周期测量说明](https://webkit.org/blog/17899/introducing-the-jetstream-3-benchmark-suite/)。

### 10.2 文本处理的边界成本

通过 wasm-bindgen 将 JavaScript 字符串传给 Rust 的 `&str` 或 `String` 时，需要从 UTF-16 转换为 UTF-8 并复制进入 Wasm 内存。返回字符串也涉及转换和复制。`JsString` 可以保留 JS 字符串，但这不等于 Rust 可以直接把它当作本地 UTF-8 字符串遍历。

因此，不建议每输入一个字符，就把整篇笔记反复传入 Wasm 并返回完整结果。建议去抖、仅传变化区间、在引擎内保留必要状态，并返回范围、标记或修改片段。两种实现都应采用同等的增量策略，否则测到的主要可能是算法差异。

来源：[wasm-bindgen 字符串说明](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/str.html)、[返回字符串的转换成本](https://docs.rs/wasm-bindgen/latest/wasm_bindgen/fn.intern.html)。

### 10.3 端到端耗时比内核速度更重要

可以把一次功能执行近似拆为：

```text
总时间 = 读取/API等待 + 桥接与数据转换 + 核心计算 + 写回与界面更新
```

假设一次操作需要 100 ms，其中读取与界面更新占 80 ms，计算占 20 ms。即使 Wasm 把计算提高到原来的 4 倍，总耗时也只是约 85 ms，且尚未计算新增转换开销。这个例子仅用于解释，不能作为项目性能预测。

若要把计算移到 Worker，需要单独验证对应 Joplin 执行环境的 Worker 创建、资源加载和消息通信能力；两种语言都不能假定天然拥有这条路径。

### 10.4 耗电：比较每次任务的能量

```text
任务能量 E = ∫ P(t) dt
```

执行时间减少不代表能量按相同比例下降，因为 CPU 频率、活跃核心、内存访问及瞬时功率可能变化。应区分插件增量耗电与包含屏幕、同步、网络等部分的 Joplin 整体耗电。

仅作算术示例：以 2 W 运行 1 秒是 2 J，以 3 W 运行 0.5 秒是 1.5 J，而以 5 W 运行 0.5 秒是 2.5 J。更快既可能省电，也可能更耗电；这些数值不是 TS 或 Wasm 的测量结果。

对于低频轻量功能，两种实现的电量差异可能小到难以稳定测量。对于持续 CPU 密集任务，Wasm 如果减少总计算工作或活跃时间，才有更明确的省电机会。轮询、重复扫描、无意义的后台活动和网络访问也可能主导耗电，应先减少不必要的工作。

来源：[Android 官方功耗 A/B 测试方法](https://android-developers.googleblog.com/2024/04/how-to-effectively-ab-test-power-consumption-for-your-android-app-features.html)、[Android 后台网络耗电说明](https://developer.android.google.cn/topic/performance/issues/bg-network-usage?hl=en)。

### 10.5 Joplin 场景判断

| 场景 | 初步建议 |
| --- | --- |
| 标签、模板、命令、调用 AI API | 优先纯 TS；优化调用次数和网络请求 |
| 输入时解析 Markdown、提取链接 | 先用 TS 增量处理；确认解析成为瓶颈后比较 Wasm |
| 全库索引、复杂规则匹配、图算法 | 值得比较 Wasm；同时减少 API 读取、重复扫描和序列化 |
| 图片、压缩等计算 | 先比较宿主已有能力和成熟实现，再决定是否引入 Wasm |
| 长时间无操作 | 优先事件驱动、减少轮询；语言本身不构成省电保证 |

### 10.6 建议的验证方法

1. 准备等价的 TS 与 Rust release/Wasm 实现，统一算法、输入和结果校验；另与实际会采用的成熟库比较。
2. 用包含中文、英文、长段落及大量链接的笔记，分别测试单篇、增量编辑和全库任务。小、中、大数据集以真实使用规模为准。
3. 分别记录冷启动、首次调用、热运行的中位数和 P95 延迟，以及峰值内存、包体、端到端时间。
4. 微基准测计算核心，集成基准测完整 Joplin 操作，避免只报告 Wasm 内核数字。
5. Android 真机固定亮度、网络条件、输入与任务数量；控制温度和后台同步，交替进行多轮 A/B 测试，加入禁用插件的基线。
6. 用受支持设备的 Android Power Profiler/ODPM 或可用的系统跟踪工具测量 CPU 时间和能量。不同设备支持能力不同；不能仅凭电量百分比变化推导精确省电比例。
7. 跟踪调试与正式性能测试分开进行，记录调试器状态。V8 官方说明，调试及性能录制可能影响 Wasm 编译层级。

建议默认采用纯 TS，将计算模块接口独立出来。只有实测发现计算瓶颈，或已有 Rust 库具有明确复用价值时，再把对应模块替换为 Wasm。是否迁移应依据端到端延迟、能量、内存和维护成本共同决定。
