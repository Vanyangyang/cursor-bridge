# Cursor 委托合同

只在构造任务信封、选择 `execution` 或处理异常状态时读取本文件。

## 委托开关

- `CURSOR_BRIDGE_DELEGATION=off` 时，Bridge 不暴露 `cursor_do`，直接调用也必须失败；其他检索、状态和启动工具继续可用。
- 用户明确拒绝委托、`cursor_do` 不可用或 `cursor_status.delegationMode=off` 时，主 Agent 直接执行，不得要求用户重新开启，也不得用其他调用绕过。
- 重新开启需要以 `CURSOR_BRIDGE_DELEGATION=on` 或未设置该变量启动新的 MCP server 进程；运行中的进程不动态切换。

## 任务信封

每项任务必须独立提供：

| 字段 | 要求 |
|---|---|
| `prompt` | 写明单一目标、必要上下文、禁止动作和预期回报；不得让 Cursor 重做主 Agent 的范围裁决。 |
| `execution` | 只能使用 `fifo` 或 `parallel_agent`。无法证明安全并行时使用 `fifo`。 |
| `read_only` | 查询与分析使用 `true`；任何文件修改使用 `false`。 |
| `allowed_paths` | `read_only=false` 时必填，使用最小工作区相对路径集合；不得含 glob、绝对路径或越出工作区的 `..`。`read_only=true` 时不得同时传此字段。它不是文件系统沙箱。 |
| `completion_contract` | 写明交付物、验证命令、允许的未完成项和最终回报格式。 |
| `background` | 默认 `true`，让主 Agent 可继续处理独立工作。 |
| `new_chat` | 默认 `true`，为任务建立干净的顶层 Cursor Agent。 |

## 路由合同

选择 `parallel_agent` 前必须同时满足：

1. 各任务没有数据、顺序或决策依赖。
2. 写任务的规范化 `allowed_paths` 两两不重叠。
3. 任务不共享 Unity、浏览器、数据库或其他可变运行时状态。
4. 每项结果可以单独验收；一项失败不会使其他结果失去意义。

任一条件不成立就使用 `fifo`。存在顺序依赖时，不要预先提交整个队列；先收回并验收前序任务，再决定是否提交后序任务。

## 调用样例

只读并行任务：

```json
{
  "prompt": "读取指定文件并返回结论，不修改任何文件。",
  "execution": "parallel_agent",
  "read_only": true,
  "background": true,
  "new_chat": true,
  "completion_contract": "返回结论、依据文件与未确认项。"
}
```

受限写任务：

```json
{
  "prompt": "按既定方案完成指定工具脚本，不扩大范围。",
  "execution": "parallel_agent",
  "read_only": false,
  "background": true,
  "new_chat": true,
  "allowed_paths": ["Tools/Example/"],
  "completion_contract": "列出改动文件并运行指定静态验证；失败时保留原始错误。"
}
```

有依赖或路径相交的任务把 `execution` 改为 `fifo`，并在前序任务验收后再派发下一项。

## 身份与收回合同

- `task_id` 是主 Agent 查询和汇总任务的稳定身份；每次派发后立即保存。
- `agent_id` 把 `parallel_agent` 任务绑定到 Agents Window 中的独立顶层会话；并行任务缺少该字段时不得假定身份安全。
- 只通过 `cursor_status(task_id)` 判断对应任务状态，不依赖当前选中的对话或最新一条回复。
- 结果至少应包含：任务状态、摘要、改动文件、执行的验证、失败或阻塞，以及原始 Cursor 回复。
- 不要求 Cursor 输出唯一终止标记或满足最小回复长度；Bridge 以 Agent 状态、停止生成和回答内容稳定性判断完成。

### 状态表

| 状态 / phase | 主 Agent 行为 |
|---|---|
| `queued/submitting/running/collecting` | 保持原任务，继续按 `task_id` 轮询；超过两分钟不构成失败。 |
| `completed` | 读取原始回复，再检查真实 diff、允许路径和完成合同。 |
| `failed` | 读取明确错误；先判断 Cursor Agent 是否真的显示失败，再决定是否返工。 |
| `needs_attention/orphaned` | 任务可能仍在运行或结果未成功回收；保留路径占用，按 `agent_id` 检查 Agent History，不自动重发。 |

R6 型假阴性处理：若 Agent History 中已存在完整最终回复而自动回收暂未完成，继续查询原 `task_id`。Bridge 应绑定原 `agent_id` 重试提取；禁止通过增加回复长度、注入终止标记或再次提交相同任务规避回收问题。

## 主 Agent 验收合同

Cursor 的完成声明只表示委托执行结束，不是项目验证结论。主 Agent 必须：

1. 检查实际 diff 与 `allowed_paths`。
2. 区分委托改动和派发前已有改动。
3. 独立运行适当的编译、静态检查、测试或旅程验证。
4. 自行决定接受、返工、串行续做或登记阻塞。
5. 保留正式验证、Tower 状态和产品裁决权。

## 失败与降级

- `agent_id` 缺失且任务尚未发送：停止扩大并行批次，可安全降级 `fifo`。任务可能已发送或状态为 `needs_attention/orphaned` 时，继续视为占用路径并检查 Agents Window，不得自动重发。
- 超时但工作区已有修改：先审查修改，不直接重复派发同一任务。
- 越过 `allowed_paths`：拒绝接收并报告越界文件。
- 并行任务产生冲突：停止自动汇总，转由主 Agent 审查。
- Agent History 或回答 DOM 短暂不可读：允许 Bridge 在同一 `agent_id` 上等待并重试；持续不可读时进入 `needs_attention`，不得误判为已完成或另起相同 Agent。
