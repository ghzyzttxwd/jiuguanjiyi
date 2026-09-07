# Variable Archive Bridge 智能托管安全重构 RC2

## 事故根因
旧 `smart_host.js` 使用 `MutationObserver` 监听整个 `document.documentElement` 子树，同时 `patchPanel()` 又会持续写入 DOM（例如 `textContent`、`className`、输入值）。这些 DOM 写入会再次触发同一个 `MutationObserver`，形成自触发循环，导致移动端 WebView 主线程被持续占用并停留在加载齿轮界面。

## 已执行的隔离措施
- 已从正式启动链彻底移除旧 `smart_host.js`。
- 已删除旧 `smart_host.js` 文件。
- 正式插件维持 v0.1.4：稳定核心 + 无 MutationObserver 的扫描器 + 惰性安全加载门。
- `experimental/smart_host_safe.js` 只有用户显式点击“加载候选模块”时才动态导入。
- 重启 SillyTavern 后实验模块不会自动再次加载。

## RC2 新增安全约束
- 不使用 `MutationObserver`。
- 每次手动载入候选模块时，`enabled` 都强制重置为 `false`。
- 关闭总开关时不存在后台归档循环。
- “执行一次”按钮在总开关关闭时禁用；内部 `runCycle()` 也二次校验 `enabled`，避免 UI 绕过。
- 卸载候选模块时强制关闭智能托管并清除定时器。
- 开启后每 15 秒最多检查一次；每次最多迁移 1 项。
- 自动归档前要求同时满足：聊天楼数、容器子项数、容器体积、闲置消息四类阈值。
- `当前/current/状态/status/元信息/metadata/身份/identity/任务/task/主线/mainquest/系统/system/临时/temporary` 等路径默认保护。
- 最近用户消息明确提到的对象不会成为归档候选。
- 自动恢复只在冷档案子键被最近用户消息明确命中、且当前 MVU 中确实不存在同路径热节点时触发。
- 真正迁移动作继续调用已实机验证的 VAB `archiveChild()` / `restoreArchive()`，沿用“快照 → 冷存储 → 修改热变量 → 重新读取验证”事务链。

## 只读未来模拟
RC2 新增“模拟未来闲置60条”诊断：
- 只读取当前 MVU；
- 在内存副本中把现有对象容器虚拟扩张到超过生产阈值；
- 只把真实现有条目视为未来闲置，把虚拟新增条目视为刚活跃；
- 继续应用最近提及保护和正式候选排序；
- 不写 MVU、不写 IndexedDB 冷档案、不写活动记录。

该功能用于验证“以后人物/武学/物品达到几十上百项时会挑谁归档”，无需为了测试人工制造几十条聊天或真实变量。

## 本地纯逻辑测试
Node.js 测试通过：
- 容器发现：PASS
- 当前世界/当前状态等受保护路径排除：PASS
- 最近提及对象保护：PASS
- 楼数不足不归档：PASS
- 小容器真实模式不归档：PASS
- 未来压力模拟可以从 8 项容器生成安全候选：PASS
- 未来模拟不会选择最近明确提及的对象：PASS
- 未来模拟前后原始对象 JSON 完全一致：PASS
- 未来闲置不足时仍无候选：PASS
- 5000 个对象容器扫描压力测试：约 12ms（当前测试环境）

## 实机已通过
- v0.1.4 正常启动 SillyTavern：PASS
- MVU 8.9 KB / 266 节点 / 楼132 正常识别：PASS
- 候选模块 RC1 惰性加载且不死机：PASS
- 智能托管默认关闭：PASS
- “只读检查”返回“当前无需迁移”：PASS

## 当前状态
正式启动链仍只到 v0.1.4，不会自动加载智能托管。RC2 继续留在 `experimental/`，等待下一次实机只读模拟验证后，再决定是否开放一次受控的自动迁移验收。