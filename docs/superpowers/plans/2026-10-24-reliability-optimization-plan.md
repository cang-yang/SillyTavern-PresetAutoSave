# 渐进优化执行计划

状态：**已完成；2026-10-25 推送 dev 并核对远端提交**。2026-10-24 用户明确授权自动推进全部重构优化，并在完成后提交推送仓库；推送目标限定 `dev`，不修改 `main`。

最新验收指示：用户明确要求停止低收益的全量独立审查循环，尽快收口，只复核对应功能。因此不再启动第九轮盲审；原六维评分退出条件由本次明确指示替代。保留数据安全、功能红绿回归、完整自动化、相关浏览器验收及精确推送门槛。历史评分如实保留，不宣称原逐维评分门槛通过。

输入：当日综合复审、独立盲审、全项目重构价值地图、`AGENTS.md`、`PRODUCT.md` 与同日设计提案。按已授权范围执行设计，保留非目标与数据兼容约束。

## 自动推进跟踪

- [x] 重新确认分支、用户未提交文件、产品约束；实现前基线 341 项测试通过。
- [x] 第一批安全修复：失败删除、保存基线、恢复串行、严格归档、合法基础名称、迁移/导入、生命周期。
- [x] 规范内容与语义比较统一；摘要可理解性和所有有效变化覆盖。
- [x] canonical 分组投影、筛选、批选和命令目标统一。
- [x] 宿主 inventory/seeding、mounted controllers、状态订阅、设置/日志资源清理。
- [x] 测量驱动性能改进、CSS 收敛、可访问性、文档与检查工具完善。
- [x] 完整自动化、浏览器四尺寸双主题、故障与恢复验收。
- [x] 按最新用户指示完成对应功能复核，停止全量盲审循环；历史发现已逐项修复。
- [x] 精确提交检查工具 `3f56216` 和产品实现 `015dac0`，未包含用户无关修改。
- [x] 恢复网络后重新检查远端分歧、推送 dev 并核对远端 SHA。

交付状态：2026-10-24 曾因代理和直连不可用受阻。2026-10-25 网络恢复，fetch 确认本地领先 3 个提交、落后 0 个提交；非强制推送成功，ls-remote 核对 dev 为 `de3ca331b78369e6a165f840feef18feaed8eeb5`。main 仍为 `186301d17d17d404976051143f8b2d987583923c`。随后仅补充本交付回执，不再启动全量审查。

第一批并行所有权：

- 数据实现者：archive-store、core/history-repository、history-backup、snapshot-writeback 及其测试。
- 保存实现者：auto-save、index、core/save-coordinator 与生命周期/保存状态辅助及其测试；提供统一 restore 接口，由中枢接 UI。
- 分组实现者：preset-grouping、panel-group-manager、panel-list-model/render、core 分组辅助及其测试。
- 中枢：panel-actions、删除命令及测试、跨模块连接、设计/计划、集成验证。共享 compatibility/history-store 暂由中枢管理，其他实现者先沟通再改。

每个实现者在自己独立的 `docs/reviews/2026-10-24-implementation-<area>.md` 记录红绿证据和后续项，不并行写本计划。不自行提交或推送；由中枢审核精确文件集。后续批次随文件所有权释放再分派。

## 独立复审改进循环

第二轮盲审已完成：88.0，未通过。完整自动化 452 项通过不替代产品门槛。

- [x] P1：嵌套扩展中的已知连接字段应用与根字段一致的排除规则；实际备份及单预设导出的两项失败回归现已通过。
- [x] P2：浅色系列/版本元信息使用不小于 12px 的可读字号；实际背景合成对比度验收覆盖系列、版本、快照及对比弹窗。
- [x] 两项修复后完整测试 460/460、模块检查、87 个文件语法和空白检查通过；双主题四尺寸验收通过。
- [x] 再次由全新上下文 reviewer 审查，不提供既往结论或目标评分；第三轮结果如下。

第三轮盲审：89.8，未通过。数据安全已达 94，但不能平均掉移动端短板。

- [x] 活跃 A/B 对比工具栏：补齐可访问名称/提示和 44px 触控目标；移动端底部操作条保留搜索/筛选，历史列表起始位置 188px。
- [x] 检查其他隐藏文字的日志/批选命令；对比、批选、日志各八个真实状态验收通过，键盘启动/关闭与清除焦点恢复通过。
- [x] 增加对应 audit、shell 与 focus 回归；完整测试 464/464、模块检查、语法及空白检查通过。
- [x] 第四轮全新上下文复审完成；未通过，进入下方修复。

第四轮盲审：89.5，未通过。剩余发现为浅色零快照版本行的祖先透明度把元信息降至 4.254:1。

- [x] 添加祖先透明度回归；移除 legacy 空版本整行淡化规则；“无快照”标签与展开提示也纳入实际对比度检查并修复。
- [x] 使用增强 audit 重跑 ordinary/empty/loading/error/performance 全部场景、四尺寸双主题，40/40 通过；完整测试 465/465，check/语法/空白检查通过。
- [x] 第五轮全新上下文复审完成；89.7，未通过，进入下方修复。

第五轮盲审发现：导入保留的旧 hash 可以错误抑制实际不同内容的自动恢复点。

- [x] 历史去重改为规范内容精确比较，不信任导入 hash，也不把重新计算的 32 位 hash 当作相等证明。
- [x] 真实 importAll → saveNowDetailed 自动保存、switch_guard、旧 hash 的等价内容、真实 hash 碰撞、空 legacy 兼容五项回归先红后绿；完整测试 470/470 通过。
- [x] 同根因扩展检查：自动保存初始化、轮询、DOM 采集、保存完成和切换收敛使用已提交规范内容基线；真实碰撞及 teardown 暂停状态残留有红绿证据。
- [x] 中枢复跑 478/478、模块检查、85 个生产文件语法、空白检查，以及浏览器切换收敛和 dirty guard，均通过。
- [x] 第六轮全新上下文独立复审完成；89.3，未通过，进入下方修复。

第六轮盲审发现：外部备份中的未知字段对象可规范化为空预设，并在替换导入中覆盖有效历史；字符串 pin 也未拒绝。

- [x] 独立外部导入校验：非空规范内容、已提供元数据及已知字段的正确类型，完整验证在任何写入之前完成。
- [x] 保持可读旧存储和救援导出兼容；不以新导入限制改写或删除既有记录。
- [x] 真实仓库和 facade merge/replace 失败不变性红绿测试；真实快照导出再导入往返、旧可选字段及官方结构通过。
- [x] 中枢复跑 487/487、模块检查、86 个生产文件语法、空白检查通过；补充保存/切换/导出两轮重复性能测量。
- [x] 第七轮全新上下文独立复审完成；89.5，未通过，正确性 93、数据安全 94，剩余对比身份呈现缺口。

第七轮盲审发现：窄屏提示词差异行堆叠后只靠红绿区分 A/B 及增删。

- [x] 每个非空差异侧提供可见 A/B、增删/相同标签及可访问名称，不依赖时间排序或颜色。
- [x] 交换 A/B、反向时间、整条新增/删除、空内容与转义回归，四尺寸双主题及英文 360px 验收；实际点击发现的装饰箭头遮挡同批红绿修复。
- [x] 中枢复跑 494/494、86 模块检查/语法、577 中英文键及空白检查通过。
- [x] 第八轮全新上下文独立复审完成；均值 90.3，但前端 89、移动无障碍 86，未通过逐维门槛。

第八轮盲审发现：设置开关的 38x20 点击区域不达标，审计漏掉零尺寸原生 input 与其 label。

- [x] 设置功能样式层提供真实 44x44 开关输入/标签，保持紧凑轨道；同批检查数值、选择和命令控件。
- [x] 全部 21 个设置控件逐个滚动验收尺寸、命中、名称/说明、键盘焦点和操作，修正 audit 漏项并证明红绿。
- [x] 完整测试 498/498、86 个生产模块及 577 个双语键检查通过；四尺寸双主题设置验收通过，数字/下拉实际更新恢复通过。按最新指示不再启动第九轮全量复审。

## 执行原则

- 在 dev 开发，保留用户已有 dirty/untracked 文件。
- 按根因分批，不将数据路径修复和视觉重写混在同一提交。
- 先证明红，再证明绿；当前 `npm test` 全绿不代表审计失败探针可以忽略。
- 每批 exact-path staging、检查 staged diff、独立可回滚提交；最终功能验收完成后 push dev。
- 不把调查风险当成已确定的实宿主故障，不夸大单次 benchmark。

## 批次 0：补全可重复验收

状态：已完成。最初 8 个假数据失败探针及后续重构探针中的风险，已转入 core/integration 正式回归；浏览器 harness 增加原生 dialog、批选作用域、下拉生命周期与实际文字对比度验收。初始探针作为原基线的历史证据保留，不代替最终测试集。

- 把 `docs/reviews/evidence/2026-10-24/audit-probes.mjs` 的场景移入相应 core/integration tests，避免仅源码正则。
- 建立宿主 save Promise barrier、存储逐操作故障、初始化阶段 barrier、监听器/timer/observer 计数。
- 在 harness 增加真实 native dialog 语义，并保留兼容 fallback 分支。
- 将 UI 矩阵、核心操作与性能测量做成固定命令；不让截图/人工 CLI 成为唯一回归方式。
- 通过标准：在未修复基线上逐项出现预期断言失败，而不是 fixture 初始化错误。

## 批次 1：保存与恢复一致性

优先级：最高。覆盖 A01、A04。

- 提取已提交基线与 mutation revision 的状态逻辑；修复 await 后 live fingerprint 假成功。
- restore 加入唯一保存协调器；明确在途/待执行请求的顺序。
- native observation 与 manual/switch guard 的历史提交、基线更新使用同一顺序契约。
- 将恢复的宿主成功/history 失败呈现为 partial，不发普通成功通知。
- observer/logger/Toast 异常不影响 transaction outcome。

验收：保存前/中/后输入、同目标/切换目标、多个排队 revision、超时/失败/重试、restore 与 auto 交错、native save 交错。最后 live 值要么已写入并有对应历史，要么明确 dirty/error/partial；不能“未写且 saved”。

## 批次 2：恢复、迁移与导入安全

覆盖 A02、A03、A10、A11、A15。可以细分成多个独立提交，不合并大型存储重写。

- strict archive enumeration 遇到单条读取/格式失败即保留数据。
- 移除仅依赖系列名称的恢复过滤；保留所有 canonical preset targets。
- read-side migration 与 tombstone/write/import 共用顺序控制。
- merge preview/apply 验证全局 ID ownership。
- 设计耐久 rollback/transaction image；避免删除尚完整的原 bucket。

验收：单条/全量读取失败、quota、写后校验失败、删除后迟到迁移、迁移中新增快照、跨 bucket duplicate ID、导入部分失败、rollback 连续失败与重启恢复。原 ID、名字、pin、hash、parent 不变；未验证恢复点不清理。

## 批次 3：生命周期状态机

覆盖 A05。

- 统一 enable/disable/delete transition 和 generation。
- 逐异步阶段检查过期工作；阶段资源随 owner 释放。
- 处理初始化失败、重复 onEnable、disable 中再次 enable、delete 中旧 callback。
- 保持 index.js 仅承担编排，不将状态机继续堆回入口。

验收：在每个 await 上暂停初始化，disable 后再释放；事件监听、timer、observer、DOM 节点、仓库写入计数均不得增长。重复初始化/清理结果幂等，失败可诊断。

依赖：与批次 1 的 quiesce 接口对齐，避免相互等待死锁。

## 批次 4：canonical 分组与差异一致性

覆盖 A06、A07、A08、A12、A14。

- 提供 resolved group projection，canonical key 与 displayName 显式分离。
- 修复 move/delete/drag/default/expand/undo 的全部 call sites。
- 不通过移除孤立历史或迁移 storage bucket 来修复视觉归属。
- diff 消费 canonical change set，特殊 prompt/order UI 保留通用 fallback。

验收：别名级联冲突、大小写、Unicode、同名跨 API、空组、嵌套组、零快照原生预设、已删除宿主预设；rename → move → undo/redo → reload 后 identity 不变。每一个 canonical 差异都有可见解释。

## 批次 5：真实宿主交互与可访问性

覆盖 A09、A13 及独立审查追加交互问题。

- 使用实际支持的 SillyTavern Popup API 对照 native modal 与 fallback。
- 菜单正确挂载，键盘可选择移动目标，diff disclosures 可键盘操作。
- 校验 Escape/outside click/Tab/焦点返回/IME，关闭后隐藏内容不留可聚焦控件。
- 1280x900、768x900、390x844、360x800，深浅主题，主要触控目标至少 44x44。
- 检查长名称、错误/partial、导入冲突、500 快照、滚动归属与宿主关闭按钮避让。

验收：主任务实际完成，不能只检查按钮有 aria-label；无新增 console error、横向页面溢出、控件遮挡或 nested-scroll trap。

## 批次 6：测量驱动的性能与模块收敛

覆盖 A16、A17 和待测 hot paths。

文件规模例外：新 `styles/group-manager.css` 保留约千行既有分组弹窗规则，
因为基础、浅色、现代布局和嵌套层的原始级联必须一起迁移并验证。
此次按功能所有权从 legacy 中提取，不按行数拆散级联；共享 token 和宿主
弹窗适配仍留在原层。具体迁移、删 hook 和浏览器证据见分组样式实施报告。
现有超大控制器只收敛已测试职责，不通过本计划扩大其产品责任。

- 建立大 preset + 小/大 history 双维度 benchmark，而非只增快照数。
- 先去除 catalog.read 的无必要 materialization，量化单 bucket 更新成本。
- 测量 canonicalization 重复工作、switch convergence 重试、observer 无关 mutation、导出 JSON 内存/阻塞。
- 仅在收益明确时缓存、分片或增量计算；缓存必须绑定 revision 并有失效测试。
- 按保存基线、host observation、目录投影、UI command 等完整职责拆分大模块。

验收：保留既有 500 快照面板优势；记录 p50/p95/max 和 long task；性能改善不能以 stale read、延迟最终意图或弱化验证换取。

## 每批共同 Gate

```text
npm test
npm run check
node --check <所有生产 .js/.mjs 文件>
git diff --check
```

相关 UI 变更加完整浏览器矩阵；相关数据变更加故障注入/回滚/兼容读取；中英文 key 和文案同批完成。记录基线、失败断言、修复后结果及残余风险。

## 并行边界

- 数据审查/测试设计、UI 宿主契约验证、benchmark 采集可独立进行。
- auto-save、history-store、index lifecycle 的实现不能无协调同时改接口；指定每个共享模块单一 owner。
- 分组 projection 完成并验证后才切换 controller/renderer。
- 每批独立复审，不把多个代理的分数平均成通过结论。

## 最终退出

按 2026-10-24 最新用户指示，退出条件为：计划内功能完成、已发现的阻塞问题修复、对应功能回归和完整 gate 通过、相关浏览器验收通过、精确提交到 dev 并核对远端 SHA。不再用重复全量盲审或目标分数扩大范围。历史第八轮均值 90.3 但未通过原逐维门槛，这一事实不改写；真实宿主与性能证据边界见交付追踪报告。
