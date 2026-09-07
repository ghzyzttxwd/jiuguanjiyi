# Variable Archive Bridge 冷档案自动召回 RC2

## 目标
归档解决“MVU热变量越来越大”；召回解决“数据归档后，模型需要时怎么自动想起来”。

核心仍是**只读读穿缓存**：

> 当前MVU + 最近聊天 → 检索相关冷档案 → 只把相关片段放进本轮Prompt → 冷档案继续留在IndexedDB

不是一提到旧对象就把它恢复回MVU。

## 检索核心 `recall_core.js`
- 只处理 `status=archived`；
- 同 pointer 已存在于当前 `stat_data` 时直接排除；
- 名称精确命中权重最高，其次标签/路径/摘要；
- 可选置顶背景；
- 可跳过 `mirroredToMemory`；
- pointer 去重；
- 默认最多6条、总9000字符、单条2600字符；
- 冷档案与当前状态冲突时明确以当前MVU/最新剧情为准。

## RC2 新增：投递通道协调器 `recall_delivery_core.js`
RC1最大的剩余风险不是“找错档案”，而是**同一份档案被不同记忆通道重复喂给模型**。RC2增加一个纯逻辑协调层。

### 会检测的通道
1. VAB旧宏 `{{varArchiveContext}}`；
2. `st-memory-enhancement` 已镜像档案；
3. 新的 `vab_cold_recall` extension Prompt；
4. 当前热MVU本身。

### 三种投递决策
- `auto-prompt`：没有可靠旧通道冲突，新召回Prompt可以使用；
- `legacy-macro`：确认 `{{varArchiveContext}}` 已实际放进Prompt来源且旧宏启用，新通道主动让路；
- `blocked-collision`：`vab_cold_recall` Prompt Key 被外部非本插件内容占用，直接阻止注入，不覆盖别人。

### 宏检测
对当前角色卡/Prompt设置/聊天元数据等已知来源做有上限的递归扫描：
- 真正找到 `{{varArchiveContext}}` → 强命中；
- 只找到裸字样 `varArchiveContext` → 弱命中，只提示，不贸然关闭新通道；
- 扫描有节点数/字符数/深度上限，并处理循环对象。

## RC2 `recall_safe.js`
- 版本 `0.2.0-rc2`；
- 唯一 Prompt Key：`vab_cold_recall`；
- 实际注入仍默认关闭且不持久化；
- 只读预览同时显示“召回结果 + 通道判定”；
- 检测到记忆增强时可跳过已镜像档案；
- 检测到强宏占位后自动让路给旧宏；
- 同名Prompt Key若不是本插件拥有，禁止清空/覆盖；
- 聊天切换/卸载时只清理自己拥有的Prompt；
- 仍无 `replaceMvuData` / `archiveChild` / `restoreArchive` 写路径。

## 和 Rehydration 的分工
当前明确拆成三层：

1. **聊天只是提到旧对象** → Prompt召回，保持冷档案；
2. **旧对象真正重新进入当前状态** → 后续允许恢复为热变量；
3. **MVU先创建了不完整的新热节点** → Rehydration“冷补缺、热覆盖”，禁止旧数据粗暴覆盖当前新状态。

## 自动化验证
当前CI覆盖：
- 召回排序、去重、字符预算；
- 热变量同 pointer 排除；
- 记忆增强镜像排除；
- 宏强/弱/无命中；
- 旧宏与新召回候选重合检测；
- Prompt Key 所有权/冲突保护；
- 循环对象与扫描预算；
- 端到端生命周期：冷归档 → 召回 → 旧宏让路 → 热节点重建 → Rehydration计划 → 热节点存在后停止重复召回；
- 5001条冷档案规模检索。

## 当前状态
- 智能归档：实验 RC4，事件驱动，默认关闭；
- 冷档案召回：实验 RC2，默认关闭；
- Rehydration：实验 RC1，只读；
- `safe_loader.js` 只有用户显式点击才动态载入上述候选；
- `bootstrap.js` 不自动载入实验模块；
- 正式 VAB 仍保持 v0.1.4 启动链。

目前用户无需做任何操作。下一阶段是冻结 Rehydration 的事务写入契约，在此之前不让自动模块修改重激活节点。
