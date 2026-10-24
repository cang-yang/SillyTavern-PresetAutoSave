# 2026-10-24 全项目重构价值地图

## 1. 结论和范围

**值得做系统性、渐进式重构，不值得推倒重写。** 当前问题集中在同一事实被多个模块重复解释，以及异步操作缺少统一的目标、完成状态和资源所有权。文件长度是线索，不是重构理由。

本轮是优化准备和架构评估，不是修复实施。生产基线仍为 `186301d17d17d404976051143f8b2d987583923c`，分支 `dev`；没有修改生产代码、提交或推送。保留原有 `.gitignore` 修改和用户未跟踪文件。

三位专项审查者分别复审数据、前端、性能/架构，中枢复核跨模块调用链、运行安全探针并合并结论。本轮专项审查沿用上下文，不冒充新的隔离盲审。此前隔离盲审为 82.2 分、未通过；当前代码未修复，不能宣布达标。

范围覆盖受版本控制的 71 个生产 JavaScript 文件，以及样式、双语资源、测试入口、产品和发布文档。覆盖的是模块责任、关键调用链和高风险场景，不意味着穷尽每条分支、完成全量安全审计或验证所有真实宿主版本。

相关材料：

- [前次全面复审及 A01–A17 证据](2026-10-24-comprehensive-audit.md)
- [独立盲审](2026-10-24-blind-review-1.md)
- [可靠性设计提案](../superpowers/specs/2026-10-24-reliability-optimization-proposal.md)
- [原实施计划](../superpowers/plans/2026-10-24-reliability-optimization-plan.md)
- [原安全探针](evidence/2026-10-24/audit-probes.mjs)
- [本轮新增安全探针](evidence/2026-10-24/refactoring-probes.mjs)

## 2. 优先问题：不能等大重构完成再修

### R01 / P1：删除失败仍清空历史、归档并提示成功

**已执行复现。** `modules/compatibility.js:810` 将宿主删除失败表达为 `false`，`modules/panel-actions.js:682` 和 `:780` 均未检查该结果。

在真实 action、history/archive 模块加内存宿主替身中，宿主始终返回 `false`：

- 单删：历史 `1 -> 0`，归档消失，返回 `true`，成功提示。
- 批删：历史 `1 -> 0`，归档消失，返回成功数量 `1`，成功提示。

先修复失败后禁止清理、禁止成功计数，再提取统一删除命令。完整流程还要定义“宿主已删、清理部分失败”的可恢复状态，不能只增加一个布尔判断便宣布事务可靠。

### R02 / P1：采集与备份采用不同的规范化规则

**已执行复现。** 输入包含 `temp_openai:'0.8'`、`bias_preset_selected:'Default'`、一个非 UUID 且未列入 order 的自定义 prompt：

- 采集结果：`{temperature:0.8,prompts:[]}`。
- 备份结果：保留 `bias_preset_selected` 和自定义 prompt，却没有 `temperature`。

涉及 `compatibility.js:350–599`、`core/preset-schema.js:146`、`core/history-backup.js:41`。这不是要求两者都删掉 prompt，而是证明规范不统一，并暴露了按标识符格式猜测内容归属的风险。必须先确定正确的保留契约，再统一入口。

### R03 / P1：保存、恢复、卸载中的已有数据风险仍未关闭

沿用前次已执行证据：旧保存完成吞掉新修改（A01）、严格归档读取吞错导致误清理（A02）、名称猜测排除真实基础预设（A03）、恢复绕开写队列导致覆盖（A04）、关闭后初始化继续挂监听（A05）、读时迁移复活已删除记录（A10）、导入与已有不同桶 ID 冲突（A11）。

这些是小范围安全修复的第一批任务，不能被“先重新设计整个项目”拖延。

### R04 / P1：批量操作目标只有名称，没有 API 身份

**源码确认，尚未做真实宿主端到端删除。** `history-panel.js:153` 保存 `Set<presetName>`；`:745–748` 执行删除时再读取当前 API；`:837–849` API 切换并不清空选择。因此跨 API 的同名预设可能成为错误目标。

选择项和提交命令都必须携带不可变 `(apiId,presetName)`。还要统一平铺与系列模式的勾选能力，以及“全选”的明确范围。

### R05 / P2：摘要与哈希的语义相互矛盾

**已执行复现。** 两个合法 prompt 只调换数组顺序，哈希变化，但 `computeChangeSummary()` 抛出 `Unexplained canonical change`。同一标识符在两个 order 组内启用状态不同，完全相同的新旧预设却能同时输出 `unchanged:true` 和“启用条目”。

不能靠捕获异常并显示“无变化”修复。需明确 prompt 定义数组顺序是否有语义，并按组身份比较 order。

### R06 / P2：设置与资源清理存在小而明确的所有权漏洞

**专项安全替身已执行：**

- 数字输入排队写入 `900`，重置设置为 `800`，旧定时器约 500ms 后又写回 `900`。`panel-settings-log.js:314–330`。
- 在事件源 A 上订阅，宿主 context 换为 B 后取消订阅，A 仍有一个监听，内部登记却已清空。`compatibility.js:1006–1059`。
- logger teardown 后持久化定时器仍执行一次 localStorage 写入。`logger.js:182/:256`。

分别用 mounted controller 取消机制、绑定原 emitter 的 disposer、明确的日志 flush/cancel 政策修复。不需要重写设置或日志系统。

## 3. “无关条目、一堆英文”为什么值得重构

这不是单一翻译缺失，也不是继续堆黑名单就能解决。

1. **内容归属与字段规范混在一起。** OpenAI 顶层白名单已经存在；其他 API 对未知字段更宽松，`extensions` 整体保留。`filterExtensionPrompts()` 用已知 ID、UUID 形状和 order 引用判断保留，无法可靠区分用户内容与运行时注入。
2. **同一内容经过不同入口，结果不同。** 实时采集、原生保存观察、历史比较、备份/导入没有真正共用同一契约。
3. **变更语义分散。** generic change set、摘要的固定 prompt 字段列表、详细 diff 的字段列表各算一次。新增字段如 `injection_trigger`、非首个 order 组和扩展对象会漏报或互相矛盾。
4. **展示把内部表示当用户语言。** 未知字段退回原始英文路径；`tool_call_recurse_limit` 没有友好名称；字符串差异被包装为 `{length,preview}` 后，摘要又按普通对象显示为“对象（2项）”。未知 prompt 字段在单独变化时可能显示技术路径，和普通参数一起变化时又被摘要遗漏。
5. **现有测试目标不够。** “有一个 changed path”不能证明用户看得懂，也不能证明所有真实变化均已展示。双语 key 一致不代表所有输出已国际化。

建议四层契约：

| 层 | 职责 | 禁止做的事 |
| --- | --- | --- |
| 采集与来源 | 区分 live、stored、native observation，提供可靠来源标记 | 仅凭英文名字或 UUID 形状删除内容 |
| 规范内容 | 明确 API 字段、别名、类型、秘密/运行时排除规则及版本 | 把显示偏好当数据过滤 |
| 语义变化 | 参数、prompt 定义、组内启用/排序、扩展变化 | 摘要和 diff 各维护一套字段解释 |
| 用户呈现 | 友好标签、条目名称、变化类型、前后值；技术路径放详情 | 把未知内容静默丢掉或伪装成无变化 |

默认呈现可采用“参数调整”“条目内容修改”“顺序/启用变化”“扩展设置变化”；未知字段可显示“其他预设设置变化”并允许查看技术详情。默认收起低价值细节是展示策略，不得影响存储、导出、恢复。

历史黑名单如继续保留，应明确其属于“隐藏显示”还是“排除存储”。不能用一个列表同时承担两者。涉及用户内容归属的不确定项先保留并诊断，连接秘密则按明确安全规则排除；不能以“保留未知”为理由导出凭据。

验收至少包括：相同内容不报变化；每个 canonical 差异均有解释；多个 order 组互不串扰；新增 prompt 字段不遗漏；中英文均可理解；查看技术详情不改变数据；旧快照不因更换显示规则被重写。

## 4. 全模块重构决策

### 4.1 预设规范与比较：最高价值，深度重构

范围：`compatibility` 的纯字段处理、`core/preset-schema`、`value-utils`、`change-set`、`history-store` 摘要、`panel-summary`、`diff-viewer`。

提取纯 `preset-contract`，返回 `{canonical, ignored, diagnostics, contractVersion}`，统一别名、类型、序列化和哈希输入。比较层输出参数、扩展、prompt 定义、组内 order 的结构化变化；摘要和详细 diff 仅做投影。

保留旧入口做临时 facade，先跑跨入口一致性测试，再切调用方。不能直接替换所有旧 hash、清洗全部历史或先改 hash 算法。历史 ID、旧 hash 和原内容保留；必要时添加带版本的派生 canonicalHash。

收益：直接解决用户最明显的噪声、漏报和看不懂问题，同时减少重复计算。风险高，必须早于大规模 UI 重写。

### 4.2 保存与恢复：最高价值，保留队列、统一写入

范围：`auto-save`、`panel-actions` restore、`save-coordinator`、`save-transaction`、`save-outcome`、`restore-baseline`、`deferred-save`、`preset-switch-convergence`。

保留现有协调器和事务核心。所有预设写入经过同一串行入口；请求包含目标、不可变内容、revision、原因。完成基线只能来自该请求，不得再次从 live 采样。恢复与人工动作的合并规则须区别于自动保存，不能被普通 coalescing 丢掉。

拆分观察适配器与保存状态控制器，使 DOM 事件只产生规范观察。统一 committed、failed、partial 状态；宿主成功而历史失败时保留可诊断状态。Toast、日志、渲染错误不能破坏提交。

验收：延迟写入期间连续修改、切预设/切 API、恢复交错、关闭、重试、原生保存观察，全都保持目标与内容一致。

### 4.3 历史仓库、导入与迁移：高价值，统一修改所有权

范围：`history-store`、`history-repository`、`history-backup`、schema、bucket reader、migration worker、catalog、storage integrity/quota。

仓库拥有 `readBucket / mutateBucket / migrateBucket / applyImportPlan` 的串行修改与验证。读取不隐式写入，或迁移进入同一所有者；避免在已持锁的 mutation 内再次等待自身队列。备份模块负责纯验证/计划，catalog 只消费已提交结果。

导入完整验证全局 ID 与目标，不止验证单个输入；替换操作需要可恢复的 rollback/journal，不能仅依赖“清空后从内存逐个写回来”。该风险见 A15，尚未在真实浏览器持续 quota 故障下完成验证。

保留现有存储格式和兼容读取，不换数据库。以确定性 interleaving 测试覆盖迁移/删桶/保存/导入交错，以及各阶段重启。

### 4.4 归档与生命周期恢复：高价值，但不要与历史仓库混为一体

范围：`archive-store`、`archive-recovery`、`lifecycle-recovery`、`snapshot-writeback`、takeover/index 恢复入口。

归档原始恢复载荷与 canonical 历史快照用途不同，保持独立。恢复必须逐项验证读取与写回，未知失败阻止清理；不存在“因为看起来像系列根名称，所以不用恢复”的规则。

手动损坏清理 `history-store.js:1393/:1410` 还以字段数小于 5 判坏，没有以 pin 或 API 有效 schema 证明数据不可用。这是源码确认的误删风险，应改为明确校验、隔离和范围预览，不应把小对象直接当垃圾。

### 4.5 删除及其他业务命令：高价值，移出 DOM handler

范围：`panel-actions` 单删/批删/恢复，以及设置中的清理命令。

一个领域命令接收不可变目标和依赖，返回逐目标结果；UI 只确认、调用、展示。重用仓库和宿主适配器，不引入通用工作流框架。

“清空所有历史”当前还清空手动分组和别名，却保留部分 tree/default 关系（`panel-settings-log.js:390–397`）。默认应保留组织数据；如需重置组织，应是另一个明确范围的操作。提示文案不能掩盖实际清理范围。

### 4.6 分组、别名、筛选与搜索：最高价值，一个规范组织模型

范围：`preset-grouping`、`panel-list-model/render`、group manager、`series-key-resolver`、group view model、command history。

统一产出 canonical group key、display label、parent、真实 preset target、availability、search text 和代表版本。树、成员、默认版本以 canonical key 关联，别名仅显示。

已执行问题包括：别名级联覆盖组、移动按别名写成员、大小写不同的当前系列被漏掉、搜索别名无结果、手工分组成员被系列名搜索排除、孤立历史被展示成另一个预设的版本。

renderer 不再重新猜测归属，也不承担迁移。不存在宿主实体的历史应明确呈现为可恢复目标，而不是改挂别人的名字。保留现有 undo/history 纯模块，补 identity 不变的测试。

### 4.7 宿主接管与下拉：高价值，按职责渐进拆分

范围：`preset-takeover`、兼容层 preset manager、`ui-injector`。

先从 `preset-takeover.js:1089` 提取宿主 inventory，提供 `{apiId,presetName,hostValue}`；再移出 `:1236/:1354/:1399` 的播种和恢复服务。自动保存不应为了枚举预设依赖下拉 DOM 控制器。

平铺 `:422` 与嵌套 `:558` 共用投影与事件控制器；保持 native change 事件路径 `:716`。控制器明确拥有键盘焦点、展开状态、定位和宿主样式恢复。

`computeSelectFingerprint():224` 仅采样数量及首/中/末文本，可能漏掉等量其他选项变化。这是源码风险，先加确定性更新测试再决定 revision 或完整轻量投影；不盲目扩大 MutationObserver。

### 4.8 生命周期与宿主适配：高价值，定向架构修整

范围：`index`、compatibility events、native-save observer、runtime timers、DOM watch、input gate。

使用 init generation/取消信号管理异步阶段。关闭后旧初始化不能继续建立资源；已建立的监听、observer、定时器、注入节点有同一 owner 的幂等 teardown。

事件 disposer 捕获订阅时 emitter。`core/native-preset-save-observer` 目前拥有 fetch/DOM 资源，应将宿主资源外壳放在 adapter，保留已测试的识别逻辑；不是仅改目录就算完成。

不需要全面引入依赖注入容器。以可重复 init/fail/retry/disable/context-replace 行为测试验证。

### 4.9 主面板与弹窗：中高价值，维护 mounted controller 边界

范围：`history-panel`、group manager、settings/log、diff popup、import preview、context menu。

拆分 view model、markup 和 mounted controller；每个 controller 接收实际 root 并返回 destroy。避免定时后全局查询“最新弹窗”来猜对象。复用已有焦点辅助、timer registry 和 import-preview 的 bind/destroy 模式。

优先修复：设置 debounce 过期写、弹窗菜单挂到 native modal 外变 inert、点击专用 div 不可键盘使用、文件选择取消留下 input、批量 checkbox 无可访问名称、日志筛选未更新 aria-pressed。

保留 shell、snapshot card、disclosure 这些内聚模块，不为了统一组件而重写。关闭后重开、两个弹窗相继出现、IME 编辑、重绘焦点和移动端操作要用浏览器行为测试。

### 4.10 保存状态与设置：中等价值，局部提取

范围：`save-status`、status indicator、ui-injector、settings。

保存状态由独立 observable 发布，面板/工具条订阅；去掉自动保存与工具条之间的 singleton setter 耦合。将持久错误/待提交状态与临时视觉状态分开，并补充 partial 表达。

设置系统已有验证和等价更新抑制，应保留。修复嵌套默认值暴露及 `getSettings()` 可变引用：已执行探针表明直接改返回值再 update 可绕过持久化和通知，但尚未证明当前 UI 正在这么做，属于接口风险。

`cleanupSizeMB` 目前仅出现在默认值、验证器和设置 UI，没有找到生产消费点。该阈值不可当成已生效的空间保护承诺；先明确容量政策和 pinned/recovery 保护，再实现或移除误导控件。不能为了达阈值静默删受保护数据。

### 4.11 性能：按测量优化，不以重写作为性能方案

此前同提交的生产面板 harness：500 快照、约 1/15/46 MiB 数据，1280 与 390 宽场景的冷/暖面板打开约 29–75ms，列表阶段无 payload IO，未记录长任务。这里的冷场景已有摘要种子，不是无目录的旧库首次迁移；缓存展开回调 2–3ms 也不等于 input-to-paint。

值得保留 bounded list、immutable snapshot summary、catalog、markup cache、事件合并。没有证据支持引入虚拟 DOM 或换 UI 框架来“解决卡顿”。

有证据的扩展风险是目录全量 clone/flush：合成 500/5000/20000 条目录约 17–22/180–266/717–790ms（详见前报告环境）。先测真实写频率和桶分布，再做按桶变更、revision、批量 flush；不能用缓存绕过提交验证。

其他值得测量而非直接宣判的问题：完整序列化后再截断日志的成本、复杂 diff 的文本规模、首次迁移、设置刷新和分组全量重绘。将 CPU、IO、打开、交互到绘制分别记录。

### 4.12 CSS、响应式和无障碍：中等价值，逐功能迁移

当前 `styles/index.css` 仍先加载大份 legacy 样式再覆盖；同一 active group-manager menu 在 `style.css:1425/:4815/:5132` 多次定义。迁移一个功能的有效规则、token 和断点到 `styles/`，比较 computed styles 和截图后删除旧定义。

已查无生产使用的旧 hook 包括 `.pas-panel-title`、`.pas-list-actions`、`.pas-gm-auto-zone-header/-hint`。先核对 harness 和动态生成再删；用户未跟踪 `_e2e_test.js` 仍引用旧 title，不得顺手改掉用户文件。

保持现有中性表面/克制强调色与宿主题兼容，不重新做营销式视觉。矩阵 1280x900、768x900、390x844、360x800，亮暗主题、长 Unicode、嵌套组、native modal、键盘与触控可达性都要保留。

### 4.13 日志、调试、主题和小工具：低重构价值，补边界测试

保留 logger 的有界缓冲、关闭 debug 的快路径、订阅隔离；补 teardown 定时器、恢复日志 schema/数量限制，诊断不默认记录完整 prompt/秘密。

保留 theme-detector 的小型生命周期适配、debug-interface 工厂、key/time 工具、集中 escaping。明确 disable 后调试命令能否修改数据，不把调试接口变成绕过状态机的入口。

没有必要建立新的主题引擎、日志框架、通用工具层或“一函数一文件”的包装目录。

### 4.14 测试、检查和发布文档：高价值，补行为证据

当前大量有用纯函数与协调器测试应保留；不足是多处 integration 测试检查源码字符串，没有执行真实交错、弹窗或事件清理。保存替身立即 resolve 会隐藏最危险的竞态。

新增可控延迟、读/写/删除失败、quota、context 替换和阶段重启测试。测试目标以用户不变量为准，不继续把名称猜测、裸英文路径等旧行为当成正确结果。

`_check.cjs` 对 namespace/default import、缺失目标、re-export 边和生产 `.mjs` 的检查有限。加负向 fixture 后再称为完整依赖检查；保留 `_test.mjs` 的 `*.test.mjs` 发现约定，不把用户 `.cjs` 脚本自动纳入。

README/安装文档“不会修改原预设文件”的承诺与实际调用宿主 save 不符。最低 host 版本 1.10 与已有 1.18 fixture 之间缺兼容矩阵证据，但这不等于已证明 1.10 不兼容。对照实际支持范围修订文档、manifest、入口和资源检查，不在本审计中假定当前上游实现。

## 5. 建议实施顺序与退出条件

| 阶段 | 工作 | 退出条件 |
| --- | --- | --- |
| 0：安全止损 | 删除失败、保存完成基线、恢复串行、严格恢复、幽灵启发式、迁移竞态、ID 冲突、跨 API 批选 | 每个问题都有先红后绿的行为测试；没有清理未验证恢复数据；部分成功不伪装成功 |
| 1：内容语义 | 预设契约、版本化派生 hash、共享 semantic delta、友好摘要和完整 diff | live/native/history/import 一致；未知真实变化可解释；不丢自定义 prompt |
| 2：存储及组织 | 仓库修改所有权、导入应用/回滚、canonical group projection、统一命令 | 目标身份稳定；别名不搬历史；重启/失败恢复通过 |
| 3：运行时与 UI | inventory/seeding、init generation、mounted controllers、状态订阅、下拉和批选交互 | 关闭不留资源；键盘/触控完成主任务；真实 popup 适配通过 |
| 4：成本与样式 | 实测 catalog/重绘热点、功能样式迁移、死 hook 清理、发布文档 | 性能预算有可重跑环境；全部 viewport 与主题通过；无行为回归 |
| 5：独立复审 | 当前 checkout 的全新上下文审查 | 六维均至少 90、完整验证通过、无 release blocker |

阶段可小范围交错，但“修一个 blocker”不应等待全部架构设计完成；改变 canonical 语义和存储应用方式则必须先写设计及兼容方案。每次提交保持独立可测、可回退。

暂不做：整体重写、换前端框架/存储库、全量历史清洗、更换 hash 算法、增加遥测、为了行数机械拆分、扩大黑名单、把所有未知字段藏掉。

## 6. 文件覆盖索引

以下索引用于说明责任覆盖，并非每个文件都应修改：

- 生命周期/宿主：`index.js`；`compatibility`、`auto-save`、`preset-takeover`、`ui-injector`、`theme-detector`。
- 数据/组织：`history-store`、`archive-store`、`preset-grouping`、`settings`、`key-utils`、`time-utils`。
- UI：`history-panel`、`panel-actions`、`panel-group-manager`、`panel-list-model`、`panel-list-render`、`panel-summary`、`panel-settings-log`、`panel-shell`、`panel-snapshot-card`、`panel-disclosure`、`diff-viewer`、`import-preview`、`group-manager-context-menu`。
- 诊断：`logger`、`debug-interface`。
- core 内容：`preset-schema`、`value-utils`、`change-set`、`json-fingerprint`、`preset-lookup-diagnostics`。
- core 仓库：`history-backup`、`history-repository`、`history-schema`、`history-bucket-reader`、`history-catalog`、`history-migration-worker`、`history-change-events`、`snapshot-summary`、`snapshot-diagnostics`、`snapshot-retention-policy`、`storage-integrity`、`storage-quota`。
- core 写入/恢复：`save-coordinator`、`save-transaction`、`save-outcome`、`serial-task-queue`、`deferred-save`、`restore-baseline`、`preset-switch-convergence`、`archive-recovery`、`lifecycle-recovery`、`snapshot-writeback`。
- core 运行时：`runtime-timers`、`native-preset-save-observer`、`native-preset-save-target`、`preset-dom-watch`、`input-gate`、`save-status`、`status-indicator`。
- core 展示/组织：`bounded-snapshot-list`、`panel-view-markup-cache`、`panel-history-change`、`series-key-resolver`、`group-manager-view-model`、`organization-command-history`、`group-alias-editor`、`drag-hover-expander`、`focus-anchor`、`menu-navigation`。
- 样式：`style.css`、`styles/index.css`、`panel-v4.css`、`dialogs.css`、`responsive.css`；以及双语 JSON、manifest、package、检查/测试入口和相关 docs/tests。

## 7. 验证记录与限制

本轮重新执行 `npm test`：341 通过；`npm run check`：通过，双语键均为 555；71 个生产 JS 与新增探针的 `node --check` 全部通过；`git diff --check` 通过（仅原有 `.gitignore` 的 LF/CRLF 提示），新增两个忽略目录内文件另行检查无行尾空白。Node 版本为 24.14.1。新增审计脚本使用内存宿主与合成值，不访问真实用户预设、IndexedDB 或网络。

新增探针运行方式（仓库根目录，每个为独立进程）：

```text
node docs/reviews/evidence/2026-10-24/refactoring-probes.mjs delete-failure
node docs/reviews/evidence/2026-10-24/refactoring-probes.mjs canonical-parity
node docs/reviews/evidence/2026-10-24/refactoring-probes.mjs prompt-permutation
```

在当前未修复基线上，三条命令均已运行，分别输出上述观测值并以预期安全断言失败退出；这是缺陷证据，不是正常测试全绿。它们位于审计证据目录，尚未加入正式测试发现；实施时需要转为正式红绿回归测试。

浏览器、性能和 82.2 分盲审证据复用同日同提交前次审查，本轮没有重新启动完整浏览器矩阵。没有操作用户真实运行中的酒馆，没有测真实手机，也没有重新核对云端部署版本。

注意：当前本地 `.git/info/exclude` 排除了 reviews/specs/plans 路径；报告和探针确实存在，但普通 `git status` 不展示它们。本轮未强制暂存或更改忽略规则。今后提交审计材料时须显式检查该规则和精确文件范围。
