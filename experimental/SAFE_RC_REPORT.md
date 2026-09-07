# Variable Archive Bridge 智能托管安全重构 RC1

## 事故根因
旧 `smart_host.js` 使用 `MutationObserver` 监听整个 `document.documentElement` 子树，同时 `patchPanel()` 又会持续写入 DOM（例如 `textContent`、`className`、输入值）。这些 DOM 写入会再次触发同一个 `MutationObserver`，形成自触发循环，导致移动端 WebView 主线程被持续占用并停留在加载齿轮界面。

## 已执行的隔离措施
- 已从稳定启动链移除旧 `smart_host.js`。
- 已删除旧 `smart_host.js` 文件。
- `manifest.json` 与 `bootstrap.js` 已回滚到实机验证过的 v0.1.3 启动链。
- 新智能托管代码仅放在 `experimental/`，当前不会被 `bootstrap.js` 导入，因此不会影响启动。

## RC1 设计约束
- 不使用 `MutationObserver`。
- 模块不会自行执行，只有显式调用 `mountSmartHostSafe()` 才会挂载。
- 智能托管默认关闭。
- 关闭时不存在后台归档循环。
- 开启后每 15 秒最多检查一次；每次最多迁移 1 项。
- 自动归档前要求同时满足：聊天楼数阈值、容器子项数阈值、容器体积阈值、闲置消息阈值。
- `当前/current/状态/status/身份/identity/任务/task/系统/system` 等路径默认保护。
- 归档动作继续调用现有 VAB `archiveChild()`，沿用已经实机验证的“自动快照 → 冷存储 → 删除热变量 → 重新读取验证”事务链。
- 最近用户消息中明确提到的对象不会被自动归档。
- 自动恢复只匹配冷档案的明确子键命中。

## 本地静态/纯逻辑测试
Node.js v22.16.0：
- `smart_host_core.js` 语法检查：PASS
- `smart_host_safe.js` 语法检查：PASS
- 14 项核心断言：PASS
- 5000 个对象的容器扫描压力测试：约 13ms（测试环境）

## 当前状态
RC1 尚未接入 `bootstrap.js`，不能影响用户现有酒馆。下一步只能在保持稳定入口不变的前提下增加“懒加载测试入口”，且必须保证该入口本身不自动加载智能托管模块。
