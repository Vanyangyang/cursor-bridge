---
name: cursor-delegate
description: "将主 Agent 已规划、边界明确且可独立验收的中轻型实现、文档、配置或工具任务委托给 Cursor Bridge；支持 execution=fifo 串行执行，以及仅在任务互不依赖、写入路径不重叠时使用 execution=parallel_agent 派发多个顶层 Cursor Agent，再按 task_id/agent_id 收回并由主 Agent 复核。Use when planned execution work is ready to hand off, the user asks Cursor to execute bounded work, or several independent tasks can run concurrently. Do not use to delegate product direction, scope or architecture decisions, Unity Scene/Prefab or PlayMode operations, formal verification verdicts, Tower state decisions, or unbounded investigation."
---

# Cursor Delegate

把 Cursor 当作执行副手。主 Agent 始终保留方向判断、范围裁决、结果审查和正式验证。

## 日常默认工作流

按以下职责链使用：

`主 Agent 调查与裁定范围 → 形成独立任务信封 → Cursor 执行 → cursor_status 按 task_id 收回 → 主 Agent 检查真实改动并验证`

- 主 Agent 决定做什么、为什么做、允许改哪里、如何验收；不要把这些判断转交 Cursor。
- Cursor 负责已决定方案内的检索、窄实现、文档、配置、脚本和工具修改。
- 默认一项任务调用一次 `cursor_do`，使用 `background=true`、`new_chat=true`；主 Agent 可在后台继续不冲突的工作。
- 默认选择 `execution=fifo`。只有确实需要同时推进且满足并行合同的任务才使用 `parallel_agent`。
- 不注入唯一终止标记，不设置最小回复长度。完成判断只依赖任务状态、稳定 `task_id/agent_id` 和实际结果。

## 检查委托门禁

仅在以下条件全部成立时委托：

- 目标、范围和预期结果已经决定。
- 每项任务都有明确的完成合同，并可被独立检查。
- 任务不要求 Cursor 自行决定产品、架构、世界观或 Tower 状态。
- 不涉及 Unity Scene/Prefab、PlayMode 状态或其他独占 GUI 操作。
- 能识别并保留工作区已有的用户改动。

若派发、等待和复核成本高于直接完成，主 Agent 直接执行。

## 选择执行方式

- 使用 `execution=fifo`：单个日常中轻型任务，或任务存在前后依赖、写入范围相交、共享可变状态、无法证明相互独立。依赖任务必须在上一项验收后再提交下一项。
- 使用 `execution=parallel_agent`：至少两个任务互不依赖、可分别验收，且所有写入路径互不重叠。
- 设置 `read_only=true`：任务只允许查询、分析或返回文本，不得修改文件。只读任务仍不得并行操作同一个外部可变状态。
- 设置 `read_only=false`：必须提供非空、无 glob、不会越出工作区的相对 `allowed_paths`。把范围缩到完成任务所需的最小路径集合；它是调度冲突声明和 prompt 约束，不是文件系统沙箱。

不得仅因任务数量多就选择并行。无法确认依赖或路径关系时，默认使用 `fifo`。

## 派发任务

1. 记录相关工作区的派发前状态，用于区分用户已有改动。
2. 按 [delegation-contract.md](references/delegation-contract.md) 为每项任务形成独立任务信封。
3. 默认使用 `background=true` 和 `new_chat=true` 调用 `cursor_do`。
4. 为每项任务保存返回的 `task_id`；`parallel_agent` 还必须保存 `agent_id`。
5. 若并行任务未返回可用的 `agent_id`，不要继续扩大并行批次；转为 `fifo` 或报告歧义状态。

## 收回结果

1. 始终用 `cursor_status(task_id)` 查询对应任务，不把当前可见的 Cursor 对话当作任务身份。
2. `submitting/running/collecting` 都是正常进行态；耗时超过两分钟本身不是失败。等待明确终态后再读取结果。
3. 将 Cursor 声明的改动与真实 diff、`allowed_paths` 和完成合同逐项对照。
4. 由主 Agent 运行风险匹配的验证。Cursor 回复不能单独支持“通过”、`Verified` 或 Tower 状态推进。
5. 分别记录每项任务为完成、部分完成、失败、超时或歧义，再汇总整个批次。

状态解释与恢复细节见 [delegation-contract.md](references/delegation-contract.md)。

## 处理异常

- 任务状态为 `needs_attention/orphaned`、歧义或会话无法绑定：视为真实 Cursor Agent 可能仍在运行，保留路径占用，先按 `task_id/agent_id` 检查历史，不要盲目重复提交。
- Cursor UI 已有最终回复但 Bridge 尚未收回：继续查询原 `task_id`，不得添加终止标记、扩大回复长度或重新派发同一任务。新版 Bridge 会在同一 `agent_id` 上重试；持续失败才进入 `needs_attention`。
- 任务超时但已产生修改：先审查修改，再决定续做、重试或回退。
- 修改越过 `allowed_paths`：停止接收该结果并报告越界。
- 并行任务出现文件冲突：停止后续合并，交由主 Agent 审查并改为串行处理。
