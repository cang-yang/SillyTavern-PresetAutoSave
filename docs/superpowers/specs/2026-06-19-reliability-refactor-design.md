# Preset Auto Save 可靠性重构设计

## 目标

把插件从“多个监听器触发一组共享变量”的实现，重构为可解释、可复现、可测试的预设版本管理流水线。重构必须无损保留现有历史、设置、分组树、快照命名、钉选状态和导入导出数据，不改变用户主要操作习惯。

成功标准：每条正式快照都能说明触发来源、规范化前后的真实变化、保存结果和对应 SillyTavern 预设；相同语义的数据不会重复入库；失败写入不会留下伪成功记录；切换、恢复和连续编辑不会串预设。

## 核心原则

1. 单一规范化口径：哈希、去重、摘要、diff、持久化均基于同一个 canonical preset。
2. 原始观测与正式历史分离：运行时噪声可进入诊断记录，但不能污染正式快照。
3. 单写入者：所有保存请求进入同一状态机，不允许事件处理器直接写存储或预设文件。
4. 可追溯：记录 trigger、source event、changed paths、ignored paths、事务结果和关联 ID。
5. 兼容优先：旧数据只读迁移到新 schema；迁移前备份，失败时继续使用旧库。
6. 官方源码是契约：从 SillyTavern `settingsToUpdate` 和 PresetManager 行为生成/验证字段策略，手写补充必须有测试。

## 方案选择

采用渐进替换，不进行一次性重写。

- 保留现有 UI、分组算法和 IndexedDB 数据。
- 新建纯函数核心与事务协调层，先在影子模式中与旧结果对比。
- 新核心达到一致性门槛后，切换写入路径；旧数据和旧读取路径保留一个兼容周期。
- 最后拆除失效的共享状态、旧归档写入假设和重复事件逻辑。

拒绝“大爆炸重写”：它无法利用现有真实场景积累，也很难证明没有造成历史数据损坏。

## 目标架构

### 1. Preset Schema Adapter

负责从 SillyTavern 实时状态提取预设，并输出：

- `canonical`: 用于哈希、摘要、diff 和保存的规范对象。
- `ignored`: 被判定为连接配置、运行时噪声或扩展瞬态数据的路径及原因。
- `metadata`: API、预设名、SillyTavern 版本、schema 版本。

OpenAI/Chat Completion 使用官方 `settingsToUpdate` 的 `isConnection=false` 字段，加上结构化处理的 `prompts`、`prompt_order` 和经过策略登记的 `extensions`。其他 API 由独立 adapter 处理，不能假定与 OpenAI 相同。

类型规范化必须按字段语义执行：只转换已知数值/布尔控件。Prompt、扩展数据和文本模板中即使出现 `"true"`、`"0.5"` 等内容也必须保持字符串，不能递归猜测类型。

### 2. Semantic Diff Engine

唯一的变化判断入口。输出机器可读 `ChangeSet`：

- changed paths 及 before/after 类型和值摘要；
- Prompt 增删改、启停和排序；
- ignored paths 及忽略理由；
- `meaningful` 布尔值。

哈希由 canonical 数据产生。若哈希变化但 ChangeSet 为空，视为核心不变量失败，写入诊断错误而不是生成“细微改动”快照。

### 3. Save Coordinator

显式状态机：`idle -> pending -> capturing -> persisting -> committed/failed`。

- 每个 `(apiId, presetName)` 拥有独立 revision。
- 新请求可合并 pending 请求，但不能覆盖正在保存的其他预设。
- 捕获时固定目标身份和 canonical 数据，后续不再读取可能已经切换的全局 UI。
- 先写 SillyTavern 预设，再提交历史事务；任一步失败都产生可重试失败记录，不伪装成功。
- switch guard、manual、restore、auto 使用同一队列，仅优先级和策略不同。

### 4. Event Gateway

DOM、SillyTavern EventSource、PromptManager observer 和兜底 polling 只产生标准化 `ChangeIntent`，不直接保存。

事件网关负责去重、来源标注和抑制内部事件。固定毫秒沉默窗口降级为 revision/token 机制；只有无法获得确定信号的兼容路径才使用超时。

### 5. History Repository v2

新快照 schema 增加：

- `schemaVersion`、`canonicalHash`、`changeSet`；
- `cause`、`transactionId`、`parentSnapshotId`；
- `saveStatus` 和必要的兼容元数据。

旧 v1 快照保持可读。首次写入某预设时惰性迁移该 key，迁移写入新 store，验证数量、ID、pin、名称和 hash 后再标记完成。旧 store 不删除，提供回退和导出。

### 6. UI 与诊断

历史卡片不再显示无法解释的“细微改动”。正常快照显示用户可理解的变化；诊断详情可展开查看触发事件、原始 changed/ignored paths 和保存事务。

日志采用有界 ring buffer 和结构化记录。默认不记录完整 Prompt 或敏感值，只记录路径、类型、长度和安全摘要。

## 数据兼容

- 设置字段保留，并增加配置 schemaVersion；未知旧字段在备份中保留。
- v1 导出继续可导入；v2 导出包含版本与迁移信息。
- 导入先完整验证到临时空间，再原子合并或替换。
- 现有 archive store 作为遗留恢复源，只读处理；修复 `savePreset()` 无返回值导致的假失败后再决定清理。
- 禁用和卸载 hook 必须返回 Promise，让 SillyTavern 等待恢复/清理完成。

## 错误处理

- 读取到少于最低有效字段的预设时拒绝保存并记录 capture failure。
- 持久化失败保留待重试事务，不创建已提交快照。
- IndexedDB 配额不足先执行可预测清理；钉选数据绝不自动删除。
- schema 不认识的新官方字段进入“unknown official candidate”诊断，不静默忽略。
- 每个异步阶段携带 transactionId，日志可以还原完整因果链。

## 测试策略

### 纯函数测试

- canonical 规范化、类型稳定、敏感字段过滤；
- 官方字段覆盖检查，确保 `settingsToUpdate` 新字段不会无声遗漏；
- ChangeSet 与 hash 不变量；
- Prompt、order、extensions 的语义 diff；
- v1/v2 导入与迁移。

### 状态机测试

- 连续编辑、合并窗口、保存中再次编辑；
- 保存过程中切换预设/API；
- switch guard 与普通防抖竞争；
- 恢复触发 DOM/SETTINGS_UPDATED 风暴；
- 网络、IndexedDB、超时和部分失败。

### SillyTavern 集成测试

- 使用本地 1.18.0 本体启动真实浏览器测试；
- 覆盖 Chat Completion、Text Completion 及可用的其他 PresetManager；
- 验证磁盘预设、内存 presets、选中项和历史记录一致；
- 使用真实样本和历史问题序列做回归测试。

## 分阶段交付

1. 建立测试运行器和当前行为基线。
2. 实现 schema adapter、ChangeSet 和不变量，先以影子模式记录差异。
3. 引入 Save Coordinator，替换自动保存与切换保护写入路径。
4. 引入 History Repository v2 和可回滚迁移。
5. 迁移 UI、导入导出和诊断信息。
6. 清除旧共享状态与失效归档逻辑，完成真实浏览器回归。

每一阶段都必须独立通过测试并保持旧数据可用；没有通过门槛的阶段不会进入主路径。
