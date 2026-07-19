# 测试与自动化

本标准定义测试可信度、覆盖率边界、自动化质量门禁和本项目规划中的验证命令。测试必须证明可观察行为和关键不变量；“命令执行过”或覆盖率上升不等于行为正确。

## 测试质量

必须检查：

- 测试验证公共或可观察行为，而不是复制实现步骤。
- 测试名称描述触发条件和预期结果。
- 修复缺陷时先有能够复现原问题的失败测试。
- 新增或修改路径覆盖成功、失败、边界、重试、取消和适用的并发路径。
- 时间、随机、网络、文件系统和外部状态可注入或控制。
- 测试之间不依赖执行顺序、真实时间、外部网络或共享脏状态。
- Mock 保留真实契约和失败语义，不因过度简化而掩盖问题。
- 单元测试覆盖分支和不变量；集成与契约测试覆盖数据库、Git、provider、forge、schema 等关键边界。
- 并发测试控制关键交错顺序，而不是只启动多个 Promise 后期待偶然复现。
- 测试失败能快速定位行为，不依赖数千行共享 fixture 或含糊快照。
- 外部 provider 的真实 smoke test 必须显式 opt-in，不进入默认、确定性的验证套件。

测试策略还必须符合 [高并发与资源安全](concurrency.md) 和 [安全、隐私与 AI 审查运行安全](security.md) 中的专项验证要求。

## 覆盖率边界

- 覆盖率用于发现遗漏，不是独立质量目标。
- 新增关键分支必须有行为断言。
- 不允许用无断言、只执行代码、过度 mock 或不可读快照提高覆盖率。
- 历史低覆盖模块采用增量棘轮；修改过的代码不得降低覆盖或扩大未验证行为。
- 高覆盖率不能抵消错误契约、缺失的失败测试、竞态或无效断言。
- 覆盖率阈值不能替代对安全、并发、迁移和外部副作用的专项验证。

## 目标仓库统一质量命令

每个被审查仓库应逐步提供下列统一能力，实际命令名可以按技术栈映射：

```text
format:check
lint
typecheck
test:unit
test:integration
test:concurrency
build
check:dependencies
check:secrets
```

命令必须可重复、可在干净环境运行，并返回稳定退出码。审查报告必须区分已运行、失败、未运行及未运行原因；读取测试文件不得记作测试已运行。

## 合并前最低门禁

除非目标仓库更具体的规则要求更严格，合并前至少满足：

- 格式检查通过。
- lint 无新增错误。
- 类型检查通过。
- 受影响单元测试通过。
- 关键集成测试通过。
- 构建通过。
- 无密钥和敏感文件进入 diff。
- P0/P1 为零。
- P2 已修复，或有负责人、原因和跟踪项的明确延期记录。
- 高风险变更包含对应专项审查结论。
- 新增关键分支有可信行为测试，修改代码没有降低增量质量基线。

若任何必需命令未运行，交付总结必须明确剩余风险，不能声称全部门禁通过。

## 自动化边界

- 优先自动化确定性强、误报低、执行快速的规则。
- 不用文件行数、函数行数、复杂度或覆盖率单项指标自动阻断所有变更。
- 静态信号必须与行为证据结合；指标不能代替人工的架构、状态和失败路径审查。
- 不允许通过全局 disable、宽泛 ignore、无约束 `any`、吞异常或降低规则级别让检查变绿。
- 必须抑制规则时，记录原因、精确范围、负责人和清理条件。
- 新门禁先以建议或观察模式收集误报率，证据稳定后再进入阻断模式。
- [通用门禁中的 `CQ-AGENT-001`](universal-gates.md#cq-agent-001同级-agent-文档必须复用-agentsmd) 必须先以确定性告警检查缺失引用、复制漂移、矛盾和循环引用，误报稳定后方可升级为阻断门禁。
- 自动化失败必须区分“确认缺陷”“配置错误”和“检查不完整”；网络或 provider 失败不能伪装成无发现。
- 任何质量命令不得静默发布、修改目标代码、提交或改变外部状态。

## 本项目当前状态

截至 2026-07-19，本仓库已实现 TypeScript/pnpm 包、自动化单元/集成测试、严格 policy/schema/profile/waiver 解析、100.0 分评分引擎、TypeScript/JavaScript AST 可读性分析，以及 `validate`、`rules`、`inspect readability`、`score` 的确定性 CLI。模型审查、七种 review input（worktree、staged、commit、range、full repository、PR、MR）、Provider、Forge、Skill、integration installer、Git Hook、发布和 CI workflow 仍未实现。

## 当前可用的 TypeScript、pnpm 与 cq 验证

当前技术基线为 Node.js 22 或更高兼容版本、严格 TypeScript、ESM、pnpm 与 Vitest。仓库已提供：

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm check
```

`pnpm check` 依次执行 format check、lint、typecheck、全部测试和 build。`check:dependencies` 与 `check:secrets` 尚未实现，不能把它们记为已运行。任何命令都不得静默降低规则、忽略失败或发布外部状态。

本地完成 `pnpm build` 后，当前可运行：

```text
cq validate [repository]
cq rules list [--profile <name>]
cq rules explain <rule-id> [--profile <name>]
cq inspect readability <typescript-or-javascript-file>
cq score <assessment.json>
```

在尚未全局安装二进制时，等价入口是 `node dist/cli.js`。当前这些命令都不调用模型、不执行目标代码、不写目标仓库。`validate` 聚合 `CQ-AGENT-001` 与有效 policy/schema/profile/rule/waiver 校验；`inspect readability` 只产生确定性候选并明确把语义评分标为 `not_assessed`；`score` 只计算调用者提供且通过边界校验的 assessment，不自行声称完成代码审查。资源、竞态或平台能力导致证据不完整时返回 exit 3，而不是静默 PASS。

下列命令仍处于规划阶段：

```text
cq review <input>
```

远程变更的 `--run-checks` 仍是与只读审查分离的规划能力，安全约束见 [目标代码执行](security.md#目标代码执行)。

## 规划中的跨仓库触发分层

本项目规划为独立的跨仓库审查系统。触发与执行必须分层，任何一层都不能静默扩大下一层权限：

1. **Agent 指令触发层**：全局或仓库 Agent 指令只识别审查时机、授权边界和路由，不复制机器政策。
2. **Skill 调用层**：Codex/Claude Code Skill 调用 CLI、解释状态并请求必要授权；普通审查不得安装或更新用户 Skill。
3. **CLI 执行层**：当前 `cq validate/rules/inspect/score` 已提供有界的只读确定性检查与计算；后续 `cq` 还将负责不可变输入、受限 AI 审查、finding 验证和报告。默认不修改目标代码、Git 状态或外部系统。
4. **项目 profile 配置层**：`.code-quality/profile.yaml` 选择规则集、质量命令、风险触发、受信 provider 名称和资源预算。它不能保存 secret、定义凭据 header、重定向 endpoint，或让待审查 head 激活新命令。
5. **Git Hook 兜底层**：用户显式安装后，pre-commit/pre-push 调用同一 CLI 和 profile。Hook 不拥有另一套规则，不能取代服务端 required check，也不能自动安装。

只有用户显式执行规划中的受管 integration 安装、查看完整变更计划并确认后，才允许修改已识别的全局路由片段或 Skill 目录。

目标仓库的 Agent 接入文档必须继续满足 [`CQ-AGENT-001`](universal-gates.md)：同级 `AGENTS.md` 是共性规则唯一事实来源，工具文档只做最小指针和工具差异。全局指令、Skill、profile 与 Hook 都是调用或配置层，不得复制一份会独立漂移的审查标准。

## 规划中的自动化测试范围

未来实现必须至少覆盖：

- Schema：rule、profile、finding、waiver 和 run 的合法与非法 fixture。
- Policy：优先级、冲突、过期 waiver 和 effective policy 输出。
- Review：确定性风险路由、finding 状态转换、去重、confidence、disposition 和 gate。
- Readability analyzer：changed-function 范围、阈值、hotspot delta、宽 `try`、嵌套 ternary、语义 nullish chain、return-object shape 和无违规的简单 fallback。
- Scoring：权重校验、一位小数输出、内部精度、applicability、缺失评估、profile override、model-version 兼容、baseline delta，以及分数不能抵消的门禁。
- Provider contract：fake executable 和本地 HTTP server，不依赖默认外部网络。
- Forge contract：URL 解析、metadata、stale head、权限和幂等发布。
- Git integration：使用临时仓库覆盖每种本地输入和 Hook mode。
- Full repository：覆盖 selector 互斥、无模型 preflight、文件/字节边界、排除项、manifest 变化、交互确认、`--confirm-full-repository <manifest-hash>` 匹配/拒绝，以及 scope/publication 授权独立性。
- End-to-end：使用确定性 fake provider，不访问外部网络。
- Concurrency/security：资源上限、stale detection、single-flight、取消、发布幂等、secret redaction 和对抗性 prompt injection。

真实 provider smoke test 规划为显式 opt-in，并排除在默认验证之外。

## Hook 与 CI 状态

Git Hook 仅处于规划阶段，当前未安装、未提供：

- 规划的 balanced preset 是 pre-commit 执行确定性检查和一次快速缓存 AI 审查并默认 warning，pre-push 执行从 upstream base 起的完整审查。
- 规划的 strict preset 允许每次 commit 前执行完整审查。
- Hook 安装必须显式执行，只修改可识别的托管 Hook；遇到未知 Hook 必须拒绝覆盖并提供 chaining 方案。
- `warn` 不阻止 commit/push；`block` 返回 CLI gate 状态。provider 或网络导致的不完整审查默认本地 fail-open，但必须醒目标记 incomplete。
- 本地 Hook 可被 Git 选项绕过，不得宣称是不可绕过门禁。

CI 也仅处于规划阶段，本仓库不启用 CI workflow。未来资产只能先放在 `templates/ci/` 作为不执行的模板，并记录最小权限、secret、预期 check name、缓存和 branch protection 配置。模板必须锁定不可变 action revision；只有获得单独运维授权并具备无生产凭据的隔离 runner 后，才可启用服务端 required check。

## 验证报告要求

报告必须逐项记录：

```text
<command>: PASS | FAIL | NOT RUN
关键输出或失败原因
未覆盖行为与剩余风险
```

没有执行的命令一律标记 `NOT RUN`；不得根据文档、代码阅读或预期结果推断 `PASS`。
