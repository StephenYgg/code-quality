# Code Review Report

Gate 为必填项；Score 为可选项。报告未启用评分时，删除 “Score / Delta / Confidence / Coverage” 一节，但不得删除 Gate。Gate 与 Score 独立，高分不能抵消阻断 finding，低分本身也不自动构成阻断。

## Gate

- Gate: `PASS | WARN | BLOCK | INCOMPLETE`
- Basis: `列出决定 Gate 的 confirmed finding、waiver、缺失的必选审查或 policy 错误`
- Scope: `change | affected_surface | repository | focused_domain`
- Effective rules: `适用规则、profile、指令来源及未解决冲突`

## Score / Delta / Confidence / Coverage（可选）

- Score / Normalized: `__/100.0`；这是唯一归一化总分，focused review 使用对应 domain subtotal，不伪装成总分。
- Raw: `earned / assessed maximum`
- Applicable maximum: `排除有理由的 not_applicable 后的总权重`
- Delta: `+/-__`，相对于明确命名的 `quality_baseline`。
- Confidence: `high | medium | low`，并说明主要证据限制。
- Coverage: `__/100.0`，列出 `not_applicable` 理由和 `not_assessed` 缺口。
- Score scope: `change | affected_surface | repository | focused_domain`
- Score model: `ID + version`
- Profile: `version/hash + compatible weights`
- Comparison: `equivalent | non-equivalent`；模型、profile 或 scope 不兼容时不得给趋势 Delta。

## Findings

Confirmed findings 按 P0、P1、P2、P3、NIT 排序。每条 finding 使用以下完整字段；没有证据证明执行路径或契约违反的疑点保留为 uncertain，不得包装成 confirmed。

### [P1] 简短、描述结果的标题

- Finding ID: `...`
- Rule: `rule_id + version`
- Status: `candidate | corroborated | confirmed | dismissed | uncertain | waived | reported`
- Disposition: `new | preexisting | unknown | not_applicable`
- Confidence: `high | medium | low`
- 位置：`path/to/file.ts:123`
- 触发条件：`输入、状态、并发、部署或失败条件`
- 实际行为：`代码当前可证明会发生什么`
- 预期行为：`正确契约或系统行为`
- 影响：`用户、数据、安全、资源、兼容或运维影响`
- 证据：`调用链、代码、测试、运行结果、日志、规范或历史`
- 修复方向：`最小且可靠的方向，不强行指定唯一实现`
- 验证建议：`需要新增或运行的具体检查`
- Review stage: `universal | readability | concurrency | security | data | performance | compatibility | UI | ...`
- Waiver: `无，或 waiver ID、owner、补偿控制与到期时间`

## Uncertain Candidates and Waivers

- Uncertain: `矛盾结论、缺失证据、潜在影响和解除不确定性所需检查`
- Waived: `finding、waiver 有效性、风险接受、补偿控制和到期时间`

## Open Questions

- `尚未确认的契约、环境、数据规模、部署拓扑或业务假设。`

## Verification

- `command`: `PASS | FAIL`；`关键结果或失败证据`
- 未运行：`command`；`原因和因此留下的风险`
- Context limits: `缺失、截断或不可访问的文件、历史、日志或环境`
- Secret check: `PASS | FAIL | NOT RUN`

## Readability Review

- Current metrics: `函数/文件规模、控制流、try 边界、条件复杂度、返回形状等适用证据`
- Delta from comparison base: `新增或变化的指标`
- Semantic concerns: `职责、业务阶段、优先级、错误边界、状态和结果形状`
- Hotspot ratchet: `PASS | WARN | BLOCK | NOT APPLICABLE`
- Deterministic coverage: `支持的语言/单元，或不可用原因`
- Residual risk: `仍需人工或后续验证的可修改性风险`

## Concurrency Review

- Hot path amplification: `请求到任务、事件、存储、缓存和远程调用的扇出`
- Race protection: `原子性、事务、唯一约束、CAS 或 owner token`
- Lock scope: `锁键、临界区、TTL、续租、等待与释放条件`
- Single-flight: `winner、loser、去重、失败与重试语义`
- Background bounds: `并发、批量、队列、重试预算、退避和背压上限`
- Multi-instance behavior: `跨进程/实例协调、缓存惊群和迟到 owner 行为`
- Resource estimate: `峰值 QPS x 扇出 x 保留时间，以及内存/存储/连接上限`
- Residual risk: `尚未消除、无法验证或需要监控的并发风险`

不涉及并发、共享状态、任务、缓存、锁、事件或资源生命周期时，也要说明 `Not applicable` 及判断依据，不能直接删除本节。

## Summary

- 变更目的和总体判断：`...`
- 做得好的部分：`...`
- 剩余风险和后续动作：`...`
- Publication: `not requested | awaiting second confirmation | published`；审查完成不代表获得发布授权。

## 无问题报告模板

没有发现问题时仍保留 Gate、Verification、Readability Review、Concurrency Review 和 Summary，并将 Findings 写为：

> 未发现需要阻断的代码问题。
>
> 已检查：`范围、调用链、风险专项和关键契约`
>
> 已运行：`命令及 PASS/FAIL 结果`
>
> 未覆盖或剩余风险：`未运行检查、上下文限制、环境或规模假设`

若必选审查或验证未完成，Gate 应为 `INCOMPLETE`，不得因“未发现”而写成 `PASS`。评分仍然可选；未评分时不要虚构 Score、Delta、Confidence 或 Coverage。
