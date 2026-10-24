# 2026-10-24 全面复审与优化准备

## 结论

当前项目具备良好的纯函数核心、保存队列、历史仓库、摘要目录、分层样式与浏览器测试底座，但**还不能按仓库的 90 分发布门槛判定为可靠**。主要缺口不是面板首屏速度，而是跨模块的并发、恢复、身份与完成状态契约。

建议采用“先修复数据安全与假成功，再统一身份和交互，最后按测量结果优化性能”的渐进路线。暂不建议整体重写、引入 UI 框架或更换存储格式。

本轮仅复审与准备，未修复生产代码。以下缺陷仍然存在，不应把本报告理解成优化已经完成。

## 范围与证据边界

- 生产代码基线：`186301d17d17d404976051143f8b2d987583923c`。
- 开始于 `main`；新增审查材料前切换到同提交的 `dev`。原有 `.gitignore` 修改与用户未跟踪文件均保留。
- 三个独立专项审查：数据正确性/安全/恢复；前端/分组/交互；性能/生命周期/可维护性。均不带本轮对话上下文，未阅读旧审查报告。
- 另有独立全产品盲审，入口仅为当前 checkout、`AGENTS.md`、`PRODUCT.md` 及检查/验证/评分要求。其结论见 [独立盲审](2026-10-24-blind-review-1.md)，不与专项分数混算。
- 中枢复跑完整原有验证、浏览器矩阵、性能场景，并将 8 个缺陷保留为可执行失败断言。
- Node 与浏览器故障注入均使用内存适配器或独立 harness IndexedDB，没有访问真实酒馆用户数据。
- 未在用户正在运行的完整 SillyTavern 实例中验证；主面板 harness 使用生产模块，但宿主 Popup、事件和保存 API 是替身。
- 没有进行依赖升级、联网依赖漏洞扫描或真实移动设备测试，也不声称穷尽了所有安全问题。

证据等级：

1. **已执行复现**：执行生产模块并得到不符合不变量的结果。
2. **源码确认**：完整调用链支持问题，但尚无对应端到端复现。
3. **测量风险**：测量说明扩展成本，不等同于现有正常场景违反预算。
4. **待实宿主验证**：浏览器标准语义已复现，实际宿主是否走该路径仍需验证。

## 优先发现

### A01 / P1：保存期间的新修改可能漏存，却被标记为已保存

- 位置：`modules/auto-save.js:1102`、`:1111`，快速跳过路径 `:900`。
- 复现：从 temperature `0.1` 修改到 `0.2`，阻塞第一次宿主写入；期间再修改到 `0.3` 并安排延迟保存；释放第一次写入。
- 实测：`live=0.3`、`disk=0.2`、`history=[0.2]`、`saves=1`、`dirty=false`、`pending=false`。
- 根因：旧请求完成后，从此刻的 live 对象采集快速指纹，把尚未提交的新值当成已提交基线。
- 改进：基线必须属于不可变的已提交请求；使用 mutation/revision 标记判断完成时是否仍有更新意图。不得仅通过清空 dirty 宣告成功。
- 证据：已执行复现，`audit-probes.mjs save-race`。

### A02 / P1：归档严格读取吞掉单条错误，卸载恢复可能删除未恢复数据

- 位置：`modules/archive-store.js:165`，调用方 `modules/preset-takeover.js:1401`、`index.js:193`。
- `listArchivedPresets({strict:true})` 仍把每个 `getItem` 失败变为 `null` 并过滤；损坏条目也可被过滤。
- 实测：存在一个读取失败的归档，严格读取返回空列表，恢复被判断为 complete，归档最终清空。
- 改进：严格路径必须对每个原始 key 做完整核对；任何未知、损坏或读取失败都阻止全量清理。
- 证据：已执行仓库 facade + recovery core 组合复现，`audit-probes.mjs archive-read`。脚本恢复回调模拟生产枚举计数，不是直接调用完整 `onDelete`。

### A03 / P1：按名称猜测“幽灵预设”会丢失合法的基础名称预设

- 位置：`modules/core/snapshot-writeback.js:47`，`index.js:194`。
- 实测：`Story` 与 `Story v2` 是两个合法历史目标，宿主中均不存在；卸载恢复只写 `Story v2`，随后清空全部历史并报告 complete。
- 根因：把“名称等于系列名且有其他版本”当成可丢弃记录的证据，违反展示与身份分离。
- 改进：保留每个 `(apiId,presetName)`；仅可使用明确可信的历史来源标记识别人工合成记录，不能依靠名称推断。
- 证据：已执行复现，`audit-probes.mjs ghost-recovery`。现有测试还把这一不安全启发式当成预期，需要修正验收条件。

### A04 / P1：恢复快照绕过保存队列，可被在途自动保存覆盖

- 位置：`modules/panel-actions.js:415`、`:420`；`modules/auto-save.js:1600`。
- `beginAtomicRestore()` 只设标志与取消定时器，没有等待或加入 active save worker；随后直接调用 `savePresetSafe`。
- 场景：保存 A 尚未落盘，恢复 B 成功，A 随后完成又覆盖 B。
- 相关问题：恢复历史写入错误在 `panel-actions.js:432` 被吞掉，之后仍走普通成功通知。
- 改进：把 restore 作为同一协调器的命令，明确排队、旧意图处理与 partial 状态。
- 证据：专项源码调用链确认；独立盲审另在浏览器中执行了阻塞保存/恢复交错并复现覆盖，见独立报告。

### A05 / P1：禁用未取消在途初始化，禁用完成后资源重新出现

- 位置：`index.js:255`、`:281`；`modules/preset-takeover.js:133`。
- 实测：阻塞初始化时第一次归档 keys 读取，执行 disable，返回 complete 且监听器为 0；释放旧初始化后出现 6 个宿主事件监听器。
- 改进：统一 lifecycle 状态机，串行化 enable/disable/delete；每个异步阶段有 generation/cancellation 检查和资源所有权。
- 证据：已执行真实入口模块复现，`audit-probes.mjs lifecycle-race`。

### A06 / P1：分组别名被写进 canonical membership

- 位置：`modules/panel-group-manager.js:816`、`:559`、`:561`，相关删除定位 `:942`。
- 场景：把 `Story` 显示名改为 `Creative`，再把另一个预设移入该分组；移动目标及持久化 override 使用显示名，形成新的 canonical `creative`，与原 `story` 分离。
- 删除已起别名的自定义分组，也存在 canonical key 对比 display name 导致找不到目标的问题。
- 改进：移动、删除、拖拽、撤销、默认版本统一携带 canonicalKey；displayName 只负责文字呈现。
- 证据：源码确认；下一轮应补 controller 级 rename → move/delete → undo 测试。

### A07 / P1：别名冲突回退仍会合并不同 canonical 分组

- 位置：`modules/preset-grouping.js:1025`、`:1120`。
- 实测：`Story V1`、`Utility V1`、`Other V1`，别名映射 `{story:'Utility', utility:'Tools', other:'Tools'}`。
- 单轮冲突回退得到 `Utility`、`Utility`、`Other`；快照分组以 displayName 为 Map key，3 个 canonical 分组最终只剩 2 个。
- 改进：分组结果从根本上以 canonical key 为索引，标签冲突只影响标签显示。
- 证据：已执行复现，`audit-probes.mjs alias-collision`。此映射可能来自旧配置/外部配置；当前别名输入校验并不能替代读取侧身份保护。

### A08 / P1：差异对比对真实变更显示“无变化”

- 位置：`modules/diff-viewer.js:196`、`:248`、`:278`；`modules/compatibility.js:512`。
- 三种已执行反例：prompt `injection_trigger` 变化；`prompt_order` 第二组 enabled 变化；`extensions.regex_scripts.findRegex` 变化。
- 三者 canonical 内容都不同，但 diff HTML 都出现 `.pas-diff-no-changes`。
- 改进：使用 canonical change set 作为差异事实源；专用展示之外保留通用字段差异兜底。
- 证据：已执行复现，`audit-probes.mjs canonical-diff`。

### A09 / P1（宿主条件）：分组菜单挂载在原生模态框之外，无法交互

- 位置：`modules/group-manager-context-menu.js:108`；harness 替身 `tests/harness/app.mjs:149`。
- 实测：把生产分组管理器放入 `dialog.showModal()`，打开菜单；菜单挂载在 body，处于 dialog 外，菜单项 focus 失败，坐标命中底下的 H3。
- 当前 harness 的 Popup 只是 div，常规菜单测试因此通过。
- 改进：菜单挂入所属弹窗内，或使用兼容的 top-layer 策略；宿主适配器与 harness 同时遵循实际模态契约。
- 证据：原生 modal 浏览器复现；未验证用户安装版本 Popup 的具体实现，不能直接宣称所有宿主版本都发生。

### A10 / P2：读触发的懒迁移与删除竞争，删除后的历史会复活

- 位置：`modules/core/history-repository.js:39`、`:123`、`:172`；`modules/history-store.js:954`。
- 实测：暂停懒迁移的 v2 payload 写入，完成删除并验证 tombstone，然后继续迁移；marker 变回 migrated，已删除 key 再次出现。
- 改进：仓库统一串行化包含迁移在内的所有写入；或 foreground read 只读，后台迁移经过同一写队列。
- 证据：已执行复现，`audit-probes.mjs migration-delete`。

### A11 / P2：合并导入允许不同预设之间出现相同 snapshot ID

- 位置：`modules/core/history-backup.js:145`；全局 ID 查询 `modules/history-store.js:1062`。
- 实测：现有 `openai::A` 与导入 `openai::B` 使用 `same-id`，merge 仍成功规划。
- 影响：按 ID 的查询、删除、重命名、锁定存在歧义；完整备份校验可能随后拒绝当前数据。
- 改进：预览与应用共用全局 ID ownership 校验，写入前拒绝跨目标冲突，不静默重命名 ID。
- 证据：已执行复现，`audit-probes.mjs import-collision`。

### A12 / P2：渲染器把已不存在预设的快照挪到其他版本下面

- 位置：`modules/panel-list-render.js:507`、`:519`。
- 专项执行：历史有 `Story` 与 `Story V2`，宿主没有 `Story`；输出只有 `openai::Story V2` 版本节点，却包含两个预设的快照。
- 不直接改写存储，但展示归属与版本级清理/应用作用域不一致。
- 改进：保留原 canonical 目标，以“宿主中不存在”状态呈现孤立历史。

### A13 / P2：移动目标选择及部分 diff 折叠区不支持键盘

- 位置：`modules/panel-group-manager.js:817`、`:831`、`:849`；`modules/diff-viewer.js:375`、`:588`。
- 移动目标是只有 click 的 div，没有 native button、tabindex 或 key handler；不能作为拖拽的可访问替代路径。
- 改进：原生按钮/选择控件，补真实 Tab/Enter/Escape 与焦点返回测试。主任务键盘阻断仍属于发布阻断，不因 P2 标签而豁免。

### A14 / P2：全部展开与嵌套渲染使用不同的 key

- 位置：`modules/history-panel.js:694`、`:509`；`modules/panel-list-render.js:651`。
- 控制器存 display key，如 `Story`/`Creative`；嵌套树查询 canonical `story`。
- 改进：默认展开、展开全部、局部展开和 view cache 共用 canonical expansion key。
- 证据：源码确认，需补含英文大写、别名、嵌套和零快照原生预设的交互测试。

### A15 / P2：导入回滚先清空所有现有 bucket，再尝试恢复内存镜像

- 位置：`modules/core/history-backup.js:264`。
- 专项故障注入中，删除可用但写入持续失败，会使原本未受影响的 bucket 也被回滚删除；仅剩内存镜像及 AggregateError。
- 尚未对应到一个已验证的真实浏览器故障组合，作为故障容错风险，不宣称实宿主发生。
- 改进：先持久化可恢复事务镜像，保留未修改原始 bucket，记录失败恢复状态；不得为回滚便利扩大删除范围。

### A16 / P2：目录写入有全量复制/重写放大

- 位置：`modules/core/history-catalog.js:115`、`:215`；`modules/history-store.js:906`。
- 单 bucket 更新复制完整 catalog、全量发布，再完整 read 以获取状态。
- 改进顺序：廉价状态查询与 summary materialization 分离，再按实际写入测量决定分片/增量策略。
- 证据：见性能测量。此项不是“当前 500 条面板速度不达标”。

### A17 / P2：部分“集成/生命周期测试”只检查源码字符串

- 位置：`tests/lifecycle-initialization.test.mjs:7`、`tests/integration/auto-save-switch-convergence.test.mjs:8`、`tests/panel-controller-lifecycle.test.mjs:7`。
- 正则可以约束接口使用，但无法验证 await 交错、写失败、焦点、真实 Popup 和事件清理。
- harness 保存替身立即完成并覆盖 live 设置，不能模拟保存中继续输入。
- 改进：保留必要结构约束，新增可控 Promise barrier、故障适配器、原生 dialog、真实事件流；性能与 UI 验证应成为可重复运行的单独 gate。

## 验证结果

原有完整验证全部通过：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 341 passed，0 failed |
| `npm run check` | import/export、依赖环、残留引用检查通过；i18n 555/555 |
| `node --check` 全部生产模块 | 71 个文件通过 |
| `git diff --check` | 通过；现有 `.gitignore` 有 LF/CRLF 提示 |

新增审计探针不是原有测试入口的一部分，不修改产品行为；其安全断言在当前生产代码上**预期失败**：

```powershell
node docs/reviews/evidence/2026-10-24/audit-probes.mjs save-race
node docs/reviews/evidence/2026-10-24/audit-probes.mjs lifecycle-race
node docs/reviews/evidence/2026-10-24/audit-probes.mjs archive-read
node docs/reviews/evidence/2026-10-24/audit-probes.mjs ghost-recovery
node docs/reviews/evidence/2026-10-24/audit-probes.mjs migration-delete
node docs/reviews/evidence/2026-10-24/audit-probes.mjs import-collision
node docs/reviews/evidence/2026-10-24/audit-probes.mjs canonical-diff
node docs/reviews/evidence/2026-10-24/audit-probes.mjs alias-collision
```

八个命令均已运行，并以对应 `AssertionError` 证明当前代码违背目标不变量。未修复，因此没有 red-green 完成证据。后续必须把这些场景转为正常测试并证明修复后变绿。

## 独立评分

独立总评为 **82.2/100，FAIL**：

| 维度 | 独立评分 |
| --- | ---: |
| 核心功能与正确性 | 80 |
| 数据安全与容错 | 60 |
| 操作逻辑与易学性 | 86 |
| 前端工程质量 | 90 |
| 移动端、响应式与可访问性 | 91 |
| 性能与可维护性 | 86 |

该 reviewer 在未收到专项发现的情况下，独立复现了归档读取失败后清除、restore 与保存竞争两项 blocker。评分反映其独立取样证据，不代表本综合报告额外发现的键盘、modal、分组身份问题已解决或已计入该 reviewer 的分数。尤其不能将前端/移动端单项分数作为已达到最终 gate 的证明。下一轮修复后必须重新做 fresh-context 审查。

## 浏览器证据

环境：Windows、Intel i7-13650HX（14 核/20 逻辑处理器）、Node v24.14.1、Headless Chrome 156、Playwright CLI 0.1.17；无 CPU/网络降速。

主面板使用生产模块、生产样式、独立 IndexedDB；并非完整 SillyTavern 窗口。harness 版本字符串为 `1.13.4-harness`，不是对真实宿主版本的认证。

### 普通数据矩阵

| 尺寸 | 深色打开 | 浅色打开 | 内置布局审计 |
| --- | ---: | ---: | --- |
| 1280x900 | 44.5 ms | 44.3 ms | 两者通过 |
| 768x900 | 45.3 ms | 45.3 ms | 两者通过 |
| 390x844 | 37.8 ms | 38.4 ms | 两者通过 |
| 360x800 | 47.5 ms | 43.8 ms | 两者通过 |

每个组合保存了截图：`output/playwright/2026-10-24-audit-{width}-{theme}.png`。中枢目视检查了 1280 深色及 360 浅色代表图；其余组合有截图及自动布局指标，不宣称全部细节均已人工逐项检查。

内置审计覆盖横向溢出、命名主要控件触控尺寸、指定标签可见性、折叠语义、页脚尺寸与对比度、view 状态、记录到的 console errors。它不是完整可访问性审计，不能替代所有控件、scroll owner 和真实键盘任务检查。

360 浅色执行并通过：折叠 Enter/Space/click、立即快照新增独立恢复点、分组改名/撤销/重做/IME/Escape、预设切换收敛、dirty switch guard、分组菜单基本键盘/外部关闭/销毁、分组搜索布局、恶意翻译转义、零历史原生系列展开。

1280/360 浅色下 empty/loading/error 六个组合内置审计通过。error 场景故意注入 `HARNESS_EXPECTED_STORAGE_FAILURE`，存在预期错误日志；不能把它表述成浏览器完全无错误。普通场景未记录到新增应用 console error，存在宿主可选 API 缺失 warning。

### 500 快照性能

| 尺寸 | 历史量 | warm 打开 | cold 打开 |
| --- | --- | ---: | ---: |
| 1280x900 | 1 MiB | 37.1 ms | 43.2 ms |
| 1280x900 | 15 MiB | 35.9 ms | 45.1 ms |
| 1280x900 | 46 MiB | 32.6 ms | 75.1 ms |
| 390x844 | 1 MiB | 29.0 ms | 51.1 ms |
| 390x844 | 15 MiB | 30.2 ms | 75.4 ms |
| 390x844 | 46 MiB | 35.6 ms | 71.2 ms |

以上 12 个组合打开阶段 payload reads/writes/archive payload reads 均为 0，记录的 longTasks 为空。每个组合预热后执行六次 series/flat 切换，最大渲染回调 2.0–3.2 ms。回调时长不是完整 click-to-paint 延迟。

“cold”指无 ready catalog，但 fixture 已提供迁移 marker 内的 summary seeds；**不等于未迁移、无元数据的首次导入/升级**。每组合一次打开采样，没有统计 p95，移动宽度也不等于移动硬件。结果只能支持当前受测面板路径表现良好。

专项对实际 catalog 核心模块做合成测量，适配器为 structuredClone 内存 store + JSON 字节计数，每档五次操作：

| 单记录 bucket 数 | 完整目录字节 | 更新一 bucket | 读取目录 |
| --- | ---: | ---: | ---: |
| 500 | 229,838 | 16.77–22.45 ms | 3.46–5.32 ms |
| 5,000 | 2,332,338 | 179.91–265.70 ms | 37.16–47.31 ms |
| 20,000 | 9,422,338 | 717.48–789.88 ms | 108.94–141.21 ms |

这是扩展性信号，含适配器克隆/序列化成本，不能当作浏览器 IndexedDB 写延迟。后续优先测量 save CPU、队列等待、switch convergence、导入导出及峰值内存，而非继续只优化打开面板。

## 架构评价

值得保留：

- core 模块已能注入依赖，故障不必依赖真实用户数据才能复现。
- canonical preset/schema、save coordinator、transaction outcome、history repository、summary catalog 已有明确基础。
- 输入监听多数收敛到相关容器，列表有有界渲染，面板通过摘要而非完整 payload 打开。
- 样式分层、纯 markup、focus anchor、双语键集及恢复错误建模已有基础。

优先收敛的职责：

- 保存：请求入队、已提交基线、用户新意图、restore、native observation 尚未形成一个闭合事务契约。
- 生命周期：局部 teardown 存在，但跨模块启动/停用没有统一取消/串行化。
- 仓库：facade queue 与 read-side migration 的写入所有权不一致。
- 分组：canonical key 与 display name 在 model/controller/renderer 三层重复推导。
- diff：独立字段白名单偏离 canonical contract。

规模只是定位信号，不单独作为缺陷：auto-save 1727 行、panel-group-manager 1647、history-store 1610、preset-grouping 1566、preset-takeover 1449、compatibility 1309、history-panel 1302、panel-actions 1158。应围绕以上完整职责提取，而不是机械按行数切文件。

## 后续交付

- [拟议设计及非目标](../superpowers/specs/2026-10-24-reliability-optimization-proposal.md)
- [分阶段执行计划与验收](../superpowers/plans/2026-10-24-reliability-optimization-plan.md)
- [独立盲审评分](2026-10-24-blind-review-1.md)
- [可执行审计探针](evidence/2026-10-24/audit-probes.mjs)

当前不能宣布优化计划完成，也不能因为旧测试全绿而忽略新复现。下一阶段应从 A01–A05 和 A10/A11 的数据不变量修复开始，每一批均独立 red-green、完整验证、可回滚，再推进身份与 UI 契约。

工作区说明：现有 `.git/info/exclude` 排除了 `docs/reviews/` 和 `docs/superpowers/` 相关目录。本轮报告与探针已实际写入，但是被忽略的本地文件，不出现在普通 `git status`，也尚未纳入版本控制。本轮未修改排除规则、未 stage/commit/push。后续若纳入提交，应只对明确的审查文件使用精确路径，不批量纳入其他本地文档。
