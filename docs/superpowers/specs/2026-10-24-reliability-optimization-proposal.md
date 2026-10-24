# 可靠性与渐进优化设计提案

状态：**2026-10-24 用户授权完整自动推进；计划内实现及功能验收完成，待提交推送。**

依据：`docs/reviews/2026-10-24-comprehensive-audit.md` 与当日独立盲审。生产基线 `186301d`。

## 目标

1. 每一次成功状态都对应可证明的已提交内容；保存期间的新输入不会丢失。
2. 自动、手动、切换保护、恢复与 native-save observation 遵循可明确推理的次序。
3. 卸载/禁用/迁移/导入失败时，未验证恢复数据继续可读、可诊断。
4. 分组别名、嵌套、排序不改变 canonical preset/series identity。
5. 相同 canonical contract 驱动 hash、summary、diff、导出与恢复。
6. 保留已验证的面板性能，优化新的测量瓶颈，而不是为行数或分数改写系统。

## 非目标

- 不增加新产品功能，不整体重做 UI，不引入 UI 框架、构建步骤、遥测或运行时网络依赖。
- 不改名 SillyTavern 预设，不改变 `(apiId,presetName)`，不清理所谓旧数据以换取代码简化。
- 不删除 legacy 存储，不借重构统一迁移所有历史，不静默修复未知损坏记录。
- 不把真实浏览器/宿主故障视为测试噪声，不修改 rubric 以获得通过分数。
- 用户已授权完成全部验证后推送 `dev`；不得更新 `main`。

补充范围：采用 `docs/reviews/2026-10-24-refactoring-value-map.md` 的 R01-R06 和全模块决策。先修失败删除保留历史/归档，再提取不可变目标的业务命令；统一采集与备份的规范化、组内语义差异和友好摘要。保留原始恢复归档与历史快照的不同用途，不做有损统一。UI controller 拥有自身定时器/弹窗资源，设置重置取消旧任务。每批文件所有者在执行计划登记，避免并行修改共享模块。

## 设计一：保存请求与完成状态

协调器接收不可变命令，至少包含 target、payload、canonical hash、revision、请求类别及副作用策略。具体字段以现有 `save-coordinator`/`save-transaction` 为基础，避免重新并行实现。

已提交基线仅从成功请求中产生，不从 await 之后的 live state 反推。完成时比较当前 target 与 mutation generation；有更新输入时保留 dirty/pending，并确保最终意图进入队列。

restore 进入同一协调器。恢复是否覆盖尚未提交编辑必须在交互契约中明确；不能靠设置 `_restoreInProgress` 假装独占写入。native-save observation 不重新执行宿主写入，但其历史提交和基线更新也必须有顺序屏障。

状态保留 `pending/saving/saved/error/partial` 区别。宿主已写成功、history 失败应为 partial，允许重试与诊断；Toast、logger、render failure 不得反转持久化事实。

## 设计二：生命周期所有权

`index.js` 只编排 lifecycle controller。controller 持有 generation、当前 transition 与阶段资源。

- enable 避免重复初始化。
- disable/delete 先失效旧 generation，等待/取消可等待阶段，再释放资源与执行恢复。
- 每个 await 后校验生命周期，过期初始化不得订阅事件、启动 timer、插入节点或重新打开仓库。
- 失败阶段的已获取资源回滚；清理可以重复调用。
- 资源关闭与恢复数据清理是不同操作，前者成功不等于后者已验证。

## 设计三：仓库与恢复事务

所有 read-modify-write、migration、tombstone、import、cleanup 共用一个可证明的写入顺序。优先利用现有 serial queue，但其边界应覆盖真正执行 writes 的模块，而不是仅覆盖部分 facade 调用。

前台只读获取可采用现有 `peekItem`，后台迁移通过统一写路径；或者在 repository 内部提供一致的序列化。实施前选择一种，避免永久双重队列及死锁。

归档 strict 模式逐 key 验证，不丢弃无法读取/不合法的记录。全量删除必须有恢复结果与原始 key 集合的覆盖关系，不能只检查 `failed===0`。

基础名称与版本名称都是合法独立目标。无法证明为合成记录的数据一律保留。

import 在写入前验证完整目标图，包括跨现有/导入 bucket 的 ID 唯一性。替换或回滚需要耐久恢复镜像或等价事务；不得先删除所有原始数据再赌后续写入成功。

## 设计四：分组与差异契约

分组结果以 canonicalKey 索引，另附 automaticName/displayName。所有 membership、tree edge、默认版本、展开状态、拖拽 payload、操作命令仅使用 canonical 身份。

别名冲突仅影响标签，不影响成员归属。读取旧 alias/membership 的兼容解释需要明确测试，不能静默将原有 override 重新解释为另一个组。

孤立历史仍归属原 preset target，提供缺失宿主预设状态，不移到其他版本下。

diff 以 canonical change set 为事实源；保留对 prompt/order 的易读呈现，但未知有效字段必须以通用差异展示。非空 change set 不得生成“无变化”。

## 设计五：宿主 UI 契约

扩展是宿主内工作台。Popup adapter 明确对原生 dialog、焦点、top layer、关闭回调的最低契约；harness 必须模拟相同语义，而非仅模拟外观。

菜单挂入所属可交互表面；目的地使用原生控件；所有重要任务有键盘和触控入口。失败/partial 文案明确作用域，配套中英文本。

继续使用现有 token/CSS hooks，新增样式进入 `styles/` 特性层，不做全局样式重写。

## 性能预算与测量

维持 500 快照交互 100 ms、打开 500 ms 目标，普通操作避免扩展造成的 50 ms 以上 long task。

新增：保存捕获/提交 CPU、队列等待、未收敛切换、大导出内存与阻塞、目录单 bucket 更新。记录硬件、浏览器、数据量、冷暖状态、重复次数、p50/p95/max。

先分离目录廉价 status 查询和完整 materialization；分片目录或新增索引需基于测量及一致性测试决策，不在本轮预先承诺数据模型变更。

## 验收与退出

每项漏洞先加入可执行失败测试，再实现；复现脚本中的 mocks 仅为起点，关键链路需生产 controller/宿主契约集成测试。

每批完整验证、四尺寸双主题、相关键盘/触控/焦点/错误路径检查，保存清晰的 red-green 证据。

2026-10-24 最新用户指示替代原全量盲审评分退出循环：停止低收益独立审查，仅对对应功能复核并快速收口。已发现问题须修复，完整 gate 和功能验收仍须通过，最后精确提交推送 dev 并核对远端。历史报告与分数不修改，不把该范围调整描述为原六维评分门槛通过。
