# Changelog

## 0.1.1

- 修复归档/恢复进入 busy 状态后，强制快照被跳过的问题。
- 修复自动归档在无需卸载时仍可能误归档一项的问题。
- 自定义宏优先使用 SillyTavern Macro Engine 2.0 `macros.register()`，保留旧版 `registerMacro()` 回退。
- 增加旧 Android WebView 的 CSS selector 转义回退。
- 记忆增强表格已镜像档案不会重复插入同一行。
- 完成 27 项静态安全/结构检查与纯函数单元测试。

## 0.1.0

- 初始版本：MVU 变量体积监控、手动归档/恢复、IndexedDB 冷存储、变量快照、导入导出、按需宏、可选记忆增强表格镜像、实验性自动归档。
