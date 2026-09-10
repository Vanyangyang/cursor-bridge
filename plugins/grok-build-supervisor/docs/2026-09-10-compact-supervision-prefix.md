# 精简每轮监督前缀

## 定稿

采用每轮发送短约定的方案，继续使用现有的 `buildSupervisedPrompt(prompt, hostKind)` 纯函数。完整长前缀替换为两行核心规则，保留身份标题、结束标记和 `[Task]` 边界。不引入首次注入标志、会话状态、版本登记、TTL 或额外协议字段。

Cursor（Claude Fable 5.1 / high）的只读评审建议采用此方案；主代理已通过 FastCtx 核对生成函数、调用点、对应测试和已安装 ACP 类型后定稿。评审任务为 `cursor-mtue0sgt-2`。

## 原因与边界

- 当前函数每轮无条件附加固定约定，空任务的包装长度分别为 Codex 952、Claude Code 988、Pi 934、中性宿主 1046 个字符。
- 当前 ACP `SessionUpdate` 类型没有专用的上下文压缩/重置事件；`usage_update` 仅提供用量，不能可靠证明规则是否仍在上下文中。
- `NewSessionRequest` 没有专用 `systemPrompt` / `instructions` 字段，不能假定 Grok 支持某个 `_meta` 私有扩展。外部 Grok 的其他行为保持 UNKNOWN。
- 每轮保留短规则可以直接覆盖旧会话、不同宿主、跨工作区、失败重试和 MCP/daemon 重启，避免增加新的持久状态。
- 缩减字符只证明输入包装变短，不声明实际 tokenizer、缓存命中、账单或历史上下文 token 的具体节省比例。

## 必须保留

1. 真实宿主身份按每次请求渲染；不宣称宿主始终在线或 ACP 前端始终附着。
2. 在任务范围内使用工具，自主取得可取得的事实；通过 ACP 返回简洁进展与结果。
3. 工具无法提供的事实或决策通过 ACP form elicitation 交给宿主；需要用户权限的决定由宿主转交用户。
4. 不把普通问答包装成权限请求。
5. 只有 elicitation 不可用时，才以一个 `<supervisor_question>...</supervisor_question>` JSON 对象结束，字段仍为 `question`、`evidenceGap`、`attempted`。
6. 原任务文本、100000 字符总长检查、单会话单轮执行和现有多工作区隔离行为保持完整。

## 实施与验收

- Cursor 仅修改 `scripts/supervisor-core.mjs` 的生成函数及 `scripts/supervisor-core.test.mjs` 的对应断言/字符预算测试，保留文件中已有改动。
- 四种宿主的空任务包装均不超过 460 个字符；保留任务文本、身份隔离和 fallback 解析测试。
- 主代理复核实际差异，运行插件测试与 Grok 技能约束检查，重建两个 Grok bundle，测量每种宿主的实际字符变化。
- 通过现有本地 marketplace 流程刷新安装缓存。运行中的会话沿用既有空闲升级保护，不为这次文案精简停止活动会话。

## 验收结果

Cursor 实施任务 `cursor-mtuehxw3-3` 已完成，配置与实际模型均为 Claude Fable 5.1 / high。主代理对照修改前工作树核验，生产代码只有生成函数中的 6 行说明替换为 2 行；其他既有修复保持不变。

| 宿主 | 原包装字符数 | 新包装字符数 | 减少 |
| --- | ---: | ---: | ---: |
| Codex | 952 | 424 | 55.5% |
| Claude Code | 988 | 442 | 55.3% |
| Pi | 934 | 415 | 55.6% |
| 中性宿主 | 1046 | 455 | 56.5% |

四种宿主均通过包含中文、换行、任务标记与 emoji 的原任务保真检查。上述数据为字符数，不是实际 tokenizer 或计费数据。

- 插件测试：147/147 通过。
- Grok 技能约束：6/6 通过。
- Pi 打包测试：11/11 通过。
- 两个 Grok bundle 已重建。
- 通过独立 FastCtx 实际文件核验，保留身份/任务边界、fallback 标签与字段以及 100000 字符总长限制；未增加持久状态或协议字段。
- 运行切换已完成：原生 MCP 分别检查 Cursor Bridge 与 Spellcast 工作区，均返回运行版本 `0.4.2+codex.20260909180453`，保留 `multiWorkspaceSessions: true`。两个工作区均无活动 ACP、运行中任务、可验证存活 TUI 或待处理权限/澄清。
- 运行中 daemon、安装缓存与源码目录中的 daemon bundle 的 SHA-256 完全一致（`306333b4c361187dbf27a14c9658d299ec480b5367ad62310b2567111c635194`）。新版生成函数已进入当前运行时；本次仅复核运行切换，没有再发起 Grok 任务，也不把构建核验声明为新的模型回复验收。
