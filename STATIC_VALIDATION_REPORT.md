# Variable Archive Bridge V0.1.1 静态验收

## 已通过

- `index.js` JavaScript 语法检查：PASS
- `manifest.json` JSON 解析：PASS
- 纯函数测试（JSON Pointer 解析/读写/删除/摘要/hash）：PASS
- 27 项工程安全/结构断言：27/27 PASS

关键断言包括：

- 自动归档默认关闭
- 记忆增强镜像默认关闭
- archive / snapshot 两个 IndexedDB store 存在
- MVU `getMvuData` / `replaceMvuData` 读写链存在
- 归档前强制快照不会被 busy 锁跳过
- 冷副本写入发生在热变量删除之前
- MVU 写回后检查 Schema 是否自动补回被归档节点
- 恢复前保存快照
- 恢复不会静默覆盖同名热节点
- 自动归档不会在 targetCount=0 时误卸载
- Macro Engine 2.0 + legacy macro 双注册路径
- 当前 MVU 存在同路径时，冷档案不重复注入
- 记忆增强插件为可选依赖
- 已镜像档案不重复写入记忆表
- Android WebView CSS escape 回退
- 插件自身无外部网络 fetch

## 尚未验证

这里无法替代用户真实 SillyTavern 手机环境完成：

- 扩展从实际 Git 仓库安装
- 酒馆扩展面板 UI 适配用户当前主题
- 用户当前 Tavern Helper/MVUbeta 版本的真实写回行为
- `{{varArchiveContext}}` 在用户当前 Macro Engine / Kemini 预设中的实机替换
- st-memory-enhancement 开启后的真实 externalDataAdapter 写表

因此 V0.1.1 应视为“可安装测试版”，不是已经通过用户终端动态验收的稳定版。
