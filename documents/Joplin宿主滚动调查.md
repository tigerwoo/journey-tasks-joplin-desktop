# Joplin 宿主面板滚动调查

## 现象与纠错

用户在实际 Joplin 中确认0.1.3仍无法滚到年历底部。此前只给html/body/root设高度，漏掉宿主包装；独立网页fixture同样漏了包装，不能证明真实宿主修复。此前“已修复”的结论应收回，以本次源码证据和后续实测为准。

## 本机宿主源码证据

只读解析 `/Applications/Joplin.app/Contents/Resources/app.asar`，应用版本3.7.21。未修改程序、用户profile或数据库。

| 宿主文件 | 确认事实 |
| --- | --- |
| services/plugins/UserWebviewIndex.html | html默认overflow:hidden；content容器是纵向flex，但未设置高度 |
| services/plugins/UserWebviewIndex.js，第95—101行 | 在body下创建joplin-plugin-content-root，再创建joplin-plugin-content |
| 同文件第127—128行 | setHtml实际为contentElement.innerHTML=args.html，只接受插入内容 |
| services/plugins/UserWebview.tsx | 面板为iframe，使用plugin-user-webview样式 |
| services/plugins/styles/plugin-user-webview.scss | iframe宽高100%；fit-to-content是另一模式 |
| gui/MainLayoutPane.tsx | 插件面板使用fitToContent=false，由布局提供视口 |

桌面源码位于[官方仓库对应目录](https://github.com/laurent22/joplin/tree/dev/packages/app-desktop/services/plugins)。此次直接证据是本机3.7.21版本，不将dev最新分支当作已安装版本。

## 根因

真实链为html > body > content-root > content > root。中间两个宿主节点高度auto，root的百分比高度缺少确定的包含块；内容增长后可能没有形成受视口限制的内部滚动区，而html外层又禁止滚动。它能解释插件年历下半部被裁掉，也说明为何不能只改任务列表样式。

这并不证明所有第三方插件的类似现象都是同一个缺陷，也不代表必须修改Joplin才能解决。

## 0.1.4 修改

- html、body及两个宿主包装均建立100%高度、min-height:0，外层overflow:hidden。
- root保留100%高度、min-height:0、flex:1 1 0与overflow-y:auto，成为受限制的主滚动区。
- setHtml只传root片段，不再传doctype/html/head/body整文档。
- 保留抽屉独立滚动与root锁定恢复。
- 添加本机只读布局诊断，显示viewport及各层clientHeight、scrollHeight、scrollTop、矩形高度、computed height/min/max-height/flex/overflow；不读取任务内容、不自动上传。

## 验证范围

- 包冒烟新增检查：编译产物setHtml不含整文档标签。
- 浏览器fixture改用真实两级宿主wrapper；包括当前样式与还原0.1.3高度遗漏的负例，三种窗口尺寸共6项。
- 这些布局用例需要真实渲染引擎执行。当前Brave进程SIGABRT，最小Swift WKWebView探针也出现sandbox extension创建失败、JS返回WKErrorDomain Code5，未取得DOM。未调整权限或禁用沙箱重试。
- 默认自动化跳过可选布局用例，不计为通过；程序滚动脚本即便通过，也不替代真实滚轮/触摸及Joplin布局验收。
- 真机复测按README；若仍失败，读取诊断后定位实际尺寸，不再盲目重复CSS修补。
