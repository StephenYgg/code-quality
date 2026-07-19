# 质量评分与独立门禁标准

评分用于展示质量趋势、证据覆盖和改进优先级，不用于决定已确认的安全、隐私、数据完整性、并发或其他阻断缺陷是否可以接受。每次完整结果必须独立展示 Gate 和 Score；高分不能补偿阻断 finding，低分但无阻断 finding 只是优先级和趋势信号。

规划中的 CLI 结果应至少展示：

```text
Gate: PASS | WARN | BLOCK | INCOMPLETE
Score: 82.5/100.0
Delta: +1.8
Confidence: high
```

## 默认 100.0 分模型

八个大项的默认权重总和必须为 `100.0`：

| 大项 | 权重 |
|---|---:|
| 行为正确性 | 20.0 |
| 人类可读性与可变更性 | 20.0 |
| 模块边界与架构 | 12.0 |
| 测试与可验证性 | 12.0 |
| 并发与资源安全 | 12.0 |
| 安全与隐私 | 12.0 |
| API、数据与发布兼容性 | 6.0 |
| 可观测性、文档与供应链 | 6.0 |
| 合计 | 100.0 |

### 行为正确性：20.0

| 小项 | 权重 |
|---|---:|
| 意图与契约一致性 | 4.0 |
| 主路径行为 | 4.0 |
| 边界与非法输入行为 | 4.0 |
| 失败、超时、重试与取消行为 | 4.0 |
| 状态转换、副作用与幂等 | 4.0 |
| 小计 | 20.0 |

### 人类可读性与可变更性：20.0

| 小项 | 权重 |
|---|---:|
| 命名、意图与业务术语 | 3.0 |
| 函数职责与规模 | 4.0 |
| 控制流与可见业务阶段 | 4.0 |
| 条件与回退优先级清晰度 | 3.0 |
| `try/catch` 与错误边界 | 3.0 |
| 状态、返回类型与结果形状 | 3.0 |
| 小计 | 20.0 |

### 模块边界与架构：12.0

| 小项 | 权重 |
|---|---:|
| 内聚性、职责与所有权 | 3.0 |
| 依赖方向与分层一致性 | 3.0 |
| 公共接口与封装 | 2.0 |
| 共享状态与生命周期所有权 | 2.0 |
| 抽象价值与重复 | 2.0 |
| 小计 | 12.0 |

### 测试与可验证性：12.0

| 小项 | 权重 |
|---|---:|
| 可观察行为覆盖 | 3.0 |
| 失败与边界覆盖 | 3.0 |
| 并发与时序覆盖 | 2.0 |
| 确定性与测试隔离 | 2.0 |
| 集成与契约覆盖 | 2.0 |
| 小计 | 12.0 |

### 并发与资源安全：12.0

| 小项 | 权重 |
|---|---:|
| 热路径放大与容量模型 | 2.0 |
| Race、原子性与 TOCTOU 保护 | 2.0 |
| 锁范围、所有权与竞争 | 2.0 |
| Single-flight、幂等与去重 | 2.0 |
| 有界工作、重试、队列与背压 | 2.0 |
| 多实例、缓存惊群与资源边界 | 2.0 |
| 小计 | 12.0 |

### 安全与隐私：12.0

| 小项 | 权重 |
|---|---:|
| 认证、授权与租户隔离 | 3.0 |
| 输入、注入、路径、URL 与文件安全 | 3.0 |
| 密钥、隐私、日志、保留与删除 | 3.0 |
| 信任边界、数据外流与最小权限 | 3.0 |
| 小计 | 12.0 |

### API、数据与发布兼容性：6.0

| 小项 | 权重 |
|---|---:|
| API、事件与 schema 兼容性 | 2.0 |
| 数据迁移与多版本行为 | 2.0 |
| 配置、发布、回滚与弃用 | 2.0 |
| 小计 | 6.0 |

### 可观测性、文档与供应链：6.0

| 小项 | 权重 |
|---|---:|
| 错误、日志、指标、trace 与告警 | 2.0 |
| 文档、仓库卫生与可运维性 | 2.0 |
| 依赖、许可证、来源与发布完整性 | 2.0 |
| 小计 | 6.0 |

`CQ-AGENT-001`（同级 Agent 文档复用）是“文档、仓库卫生与可运维性”小项中的必检证据，不新增独立权重：目标仓库存在同级 `CLAUDE.md`、`GEMINI.md` 或其他 Agent 入口时，这些文件必须先要求完整读取并遵守 `AGENTS.md`；共性规则只能由 `AGENTS.md` 持有，同级入口只记录该 Agent 或工具独有且无法上收的增量要求。审查必须以文件路径和重复条款 diff 为证据；不存在同级入口时可标记该规则 `not_applicable` 并说明理由。该规则与本小项共享最多 `2.0` 分，不重复计分，也不能抵消任何独立 Gate。

每个小项必须具名且有证据锚点。不得保留未命名的“其他”权重，也不得通过隐藏 prompt 修改小项；新增、删除、重命名、重设 evidence anchor 或调整权重都必须产生新的 score-model version。

## 小项评分锚点

每个小项按 `0.0` 到 `5.0` 评分，步长为 `0.5`，再按 `小项权重 x rating / 5.0` 换算 earned points。各领域可增加更具体的 evidence anchor，但不得改变以下公共含义：

```text
5.0  证据完整，不存在实质缺口。
4.0  存在小缺口，但不妨碍局部理解或修改。
3.0  存在实质维护成本，行为需要跨代码核对。
2.0  关键行为难以证明，修改容易产生回归。
1.0  结构严重混杂，依赖测试兜底或作者知识。
0.0  无法可靠审查该单元，或存在已确认的关键失败。
```

相邻锚点之间的半分必须给出同时落在两级证据之间的理由。每个 `scored` 小项都要记录 rating、earned points、maximum points、confidence、证据位置和解释；不得只给数字。

## 适用性与覆盖率

每个小项只能处于以下一种状态：

- `scored`：已完成评估，必须包含 rating、confidence 和 evidence anchors。
- `not_applicable`：该小项对当前 scope 确实不适用；必须说明理由，并从 applicable points 中排除。
- `not_assessed`：该小项适用但未评估；必须记录原因和缺失证据，作为显式 coverage gap，且不能宣称满分。

令：

- `applicable maximum` 为除 `not_applicable` 外所有小项的权重总和。
- `assessed maximum` 为所有 `scored` 小项的权重总和。
- `earned` 为所有 `scored` 小项 earned points 的总和。

完整报告必须同时展示：

- `Raw`：`earned / assessed maximum`，保留实际已评估权重，例如 `73.0/86.0 assessed applicable points`。
- `Normalized`：`earned / assessed maximum x 100.0`，例如 `84.9/100.0`。
- `Coverage`：`assessed maximum / applicable maximum x 100.0`，例如在 applicable maximum 为 `100.0` 时为 `86.0/100.0`。

`not_applicable` 的理由和 `not_assessed` 的缺口必须与数值一起展示。归一化不得隐藏未适用或未评估维度；required item 为 `not_assessed` 时，Gate 必须为 `INCOMPLETE`，即使 available normalized score 很高。focused review 只报告其 domain subtotal，不得伪装为仓库总分。

## Scope、置信度与证据

每个 score result 必须记录以下 `scope` 之一：

- `change`：仅当前比较基线到目标变更。
- `affected_surface`：当前变更及其直接调用者、依赖和契约面。
- `repository`：按声明的仓库覆盖范围评估。
- `focused_domain`：仅评估明确指定的质量领域。

baseline 和 trend 只能比较相同 scope。报告还必须记录每个小项的 confidence、整体 confidence 及其聚合规则、证据位置、未读取或被截断的上下文、已运行与未运行的验证。置信度描述证据质量，不改变 severity，也不能把缺少评估伪装为低置信度评分。

## Profile 权重与模型版本

Profile 可以调整大项权重、小项权重，或增加仓库专属小项，但必须满足：

- 大项权重总和精确为 `100.0`，精度一位小数。
- 每个大项内小项权重总和精确等于该大项权重。
- 经过适用性处理前，完整 score model 的全部具名小项总和精确为 `100.0`。
- 零权重关键领域不禁用该领域的规则、审查阶段或 Gate。
- 非法权重、未命名剩余权重或总和不等于 `100.0` 时，模型无效并触发 policy failure。

每个结果必须记录 score-model ID、score-model version、profile hash、rule versions 和 rounding mode。增加、删除、重命名、重新锚定或重新加权任一小项都创建新的 score-model version。只有 score-model version 相同且 profile weights 兼容的结果才可作等价 trend 比较；否则规划中的 CLI 应明确标记 `non-equivalent`，不得计算误导性 delta。

## 精度与舍入

所有展示的 points、totals、normalized score、coverage 和 delta 都使用一位小数。内部计算保留更高精度，只在 presentation boundary 按一个有文档记录的统一 rounding rule 舍入。不得逐项提前舍入后再累加，也不得使用不同舍入方式制造 `100.0` 总分。

## Baseline delta

评分报告必须与所选 quality baseline 比较，并展示每个大项和每个小项的当前值、基线值和 delta。比较要求：

- scope 完全相同。
- score-model version 相同且 profile weights 兼容。
- `not_applicable` 和 `not_assessed` 状态变化显式展示，不能折叠为分数变化。
- 历史低分不要求一次性重写，但被修改热点不得静默降低 applicable score 或违反 metric ratchet。
- 无可靠基线或模型不等价时，delta 标记为不可比较，并说明原因。

## Gate 独立性

Gate 只能取 `PASS`、`WARN`、`BLOCK` 或 `INCOMPLETE`，并独立于总分计算：

- `BLOCK`：存在达到配置门槛的 confirmed finding，或命中密钥暴露、数据损坏、不安全并发放大、无效策略等独立阻断条件。
- `INCOMPLETE`：强制审查、必选小项或必选验证未完成，无法形成完整结论。
- `WARN`：未达到阻断条件，但存在需显式关注的非阻断发现、非必选 coverage gap 或趋势退化。
- `PASS`：强制审查完整，且没有达到阻断条件的 confirmed finding。

P0/P1、profile 配置为阻断的 P2、secret exposure、data corruption、unsafe concurrency amplification、invalid policy 和 incomplete mandatory review 保留各自 Gate 语义。有效 waiver 只能按豁免标准改变 Gate disposition，不能删除 finding 或回写评分。报告必须始终并列展示 Gate、Score、Delta、Confidence、Coverage、scope 和 score-model version。
