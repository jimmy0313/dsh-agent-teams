# 使用指南（详细）

本文档收纳 dsh-agent-teams 的详细使用内容：工作原理、Web UI 行为、工具一览、配置与已知限制。README 只保留简介与快速上手。

## 工作原理

`dsh-agent-teams` 复用 DSH 的能力接缝（capability seam），不依赖 workflow 引擎：

| DSH 能力 | AgentTeams 用法 |
|---|---|
| `ctx.tools` 注册表 | 注册 10 个 `agent_teams_*` 工具（与 `tool-workflow` 同一注册路径） |
| `ctx.subagents.startContinuable()` | 创建成员：durable 可续聊子代理，带成员 persona |
| `ctx.subagents.followup()` | 唤醒收件成员（消息进入其下一轮次） |
| 持久化团队成员表 + `ctx.agents` | 前者保存 durable 成员身份，后者提供真实 `running / idle / ready` 活动状态（不依赖易变的子代理目录投影） |
| `agent/status` | 成员进入 idle 后触发共享任务池自动续领与下一轮唤醒 |
| `ctx.systemPrompt.section()` | 注册"AgentTeams 使用策略"提示段 |
| Web server 路由注册 | 活动面板数据路由 `/plugins/dsh-agent-teams/state` + 鲸鱼图片静态服务（`webServer`/`httpServer` 双键兼容，见下） |
| 文件系统 | 团队状态持久化在 `<workspace>/.agent-teams/<teamId>/` |

数据链路：工具执行 → 磁盘状态（真相源）→ host 快照路由 → 浮层 1s 轮询渲染；会话日志同时写入 `agent-teams/*` 事件（审计/重放/复盘）。

> **内测版本兼容**：npm `latest`（`0.0.1-rc.1`）的服务键仍是 `ctx.httpServer` / `ctx.workspace`，后续 `next`（`rc.2`）重命名为 `ctx.webServer` / `ctx.workspaceRegistry`。插件对两组键都做了探测（新键优先、旧键回退，`internal/service` 事件同时监听两组），两个版本都能注册路由。

### Web UI

- **右上角活动面板**（`shell.overlay` 非模态浮层）：团队创建后自动展开；默认停靠在会话右侧，高度随内容增长，达到视口安全上限后才在面板内部滚动，不用空白填满屏幕。面板可切换为浮动窗口后拖拽，停靠态支持左边缘调宽，浮动态还支持底边和右下角调整大小；只有用户主动纵向缩放后才固定浮动态高度。位置、手动尺寸和停靠模式会在刷新后恢复；标题栏的收起按钮会折叠为右上角小浮标（团队数 + 活动脉冲点）。每个团队展示组织者、分段总进度、状态统计、可折叠成员树和紧凑任务 DAG。DAG 以真实 SVG 曲线连接依赖，悬停或键盘聚焦可预览完整上下游链，点击固定，`Esc` 取消；选中节点会显示负责人、未满足前置和下游解锁信息。成员行展示职业头像、角色、实时状态和任务标签，点击可打开成员子会话。
- **小鲸鱼形象**：组织者/成员头像为 DeepSeek 小鲸鱼职业插画（`assets/agent-teams/`，8 角色 + 6 动作），按角色关键词匹配；状态动作小图随成员状态切换并带动画（工作浮动 / 空闲呼吸 / 未知思考），未读消息头像外圈光晕；遵循 `prefers-reduced-motion`。
- **会话跟随**：面板只显示**当前会话**的团队（按 captainSessionId 匹配）；新建会话面板自动收起，切回团队会话恢复。
- **对话流卡片**：团队创建时对话流出现轻量卡片（成员一览、点击跳转成员会话、"活动面板"按钮可重新激活已关闭的浮层）。
- **子代理设置页**：左侧边栏 Settings 面板里的「子代理设置」页（`settings.section` 槽）。同一页面定义子代理角色目录（内置 `researcher / engineer / reviewer / qa / designer / security / docs / data / operator` + 可添加自定义角色），每个角色可配置**显示名称、职责描述（写入成员 persona）与 Provider/模型/思考强度**；另有全局默认路由（回退）、单次输出上限（`memberMaxTokens`）、团队人数上限（`maxMembers`）与成员再委派深度（`memberMaxDepth`）。保存后写入运行时设置文件，角色匹配的路由与职责描述优先于全局默认，对之后新建的成员生效。
- **历史复盘**：`agent_teams_delete` 将团队**归档保留**（`<stateRoot>/archive/<teamId>/`，成员、任务、依赖图和邮箱完整留存）；结束团队时成员会被标记为 removed，但仍保留在 Harness 的子代理目录中供历史会话寻址，后续唤醒则继续被拒绝。历史快照保留整支队伍，并以空闲/已交付状态展示。即使旧会话没有对话流卡片，重启后选择该队长会话也会做一次轻量冷发现，恢复成员树与 DAG；点击成员可打开其持久化会话记录。

### 团队状态文件

```
<workspace>/.agent-teams/<teamId>/
├── team.json            # 团队记录：成员、任务（含依赖）、任务序号
└── inbox/
    ├── captain.jsonl    # 组织者邮箱（成员 → 组织者）
    └── <member>.jsonl   # 每个成员一个邮箱（JSONL）
```

任务状态机：`pending → claimed → in_progress → completed | failed | cancelled`。每次执行携带单调 `attempt` + 唯一 `attemptId`；转派先使旧 attempt 失效，再中断并等待旧成员安静，因此迟到更新无法覆盖新结果。领取前校验依赖，并禁止成员同时拥有两个未完成任务。

## 工具一览

| 工具 | 作用 |
|---|---|
| `agent_teams_create` | 创建团队，调用者成为组织者（一个组织者同时只带一个团队） |
| `agent_teams_add_member` | 拉成员入队（spawn 可续聊子代理 + 成员 persona） |
| `agent_teams_remove_member` | 安全移除成员：撤销 attempt、回收其未完成任务、等待中断收敛后重新调度 |
| `agent_teams_create_task` | 创建任务，支持 `dependencies` 依赖声明与 `assignee` 指派 |
| `agent_teams_reassign_task` | 原子重试/转派任务；`assignee=captain` 表示组织者安全接管 |
| `agent_teams_claim_task` | 领取任务（校验依赖；组织者可代领，成员只能领自己的/未指派的） |
| `agent_teams_update_task` | 携带当前 `attempt_id` 推进任务；拒绝旧 attempt 和终态结果覆盖 |
| `agent_teams_send_message` | 任意成员→任意成员/组织者：消息直达对方邮箱并唤醒对方（无组织者转发；拒绝冒名 `from`） |
| `agent_teams_status` | 团队全景：成员活动、任务清单、组织者邮箱、各成员待读消息 |
| `agent_teams_delete` | 结束团队：打断成员，团队目录**归档保留**（任务与依赖图、邮箱完整留存） |

`agent_teams_add_member` 默认不需要模型参数：成员沿用组织者当前 LLM provider/model 时，会一并快照组织者当前思考强度。用户明确要求某个角色使用其他模型时，可以同时传入可选的 `provider` + `model`；只覆盖 `model` 时沿用组织者当前 LLM provider。provider 或 model 任一改变时，思考强度自动使用目标模型默认档；用户明确要求某个成员使用特定强度时，可以传入可选的 `reasoning_effort`（目标模型支持的档位 id，或 `"default"` 表示强制使用模型自身默认档）。插件不会为每个成员发起二次选择或弹窗。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: agent-teams
  config:
    stateDir: .agent-teams        # 团队状态目录名（工作区下）
    memberProvider: spawn         # 子代理运行后端（spawn / fork），不是 LLM provider
    memberModel: deepseek-v4      # 可选：成员模型覆盖
    memberMaxDepth: 1             # 成员再委派深度上限（0 = 禁止）
    maxMembers: 8                 # 团队人数上限
    # settingsFile: ~/.dsh/dsh-agent-teams/settings.json  # 运行时设置文件（可选）
```

最终优先级为：成员显式 `provider` + `model` / `model` → 运行时设置的默认路由（设置面板）→ `memberModel` → 组织者当前路由。成员沿用组织者当前 provider/model 时继承组织者的思考强度；provider 或 model 任一改变时自动使用目标模型的默认档。显式 `reasoning_effort`（目标模型支持的档位 id，或 `"default"`）优先，其次为设置面板的默认思考强度，最后才是组织者继承；并都在目标 provider/model 上创建前校验，不兼容时成员创建会明确失败。最终生效的 provider/model/思考强度会写入 `team.json`，供状态查询和成员冷恢复使用。

### 运行时设置（左侧边栏 Settings → 子代理设置）

左侧边栏 Settings 面板的「子代理设置」页把可变的角色定义与费用控制写入一个独立 JSON 文件（默认 `~/.dsh/dsh-agent-teams/settings.json`，可用 `settingsFile` 覆盖路径）。它不与 profile 的静态配置混淆，也随进程读取、在成员创建时生效：

```jsonc
{
  "memberModel": { "model": "deepseek-chat", "reasoningEffort": "low" },
  "roleModels": {
    "researcher": { "model": "deepseek-chat", "reasoningEffort": "low" },
    "engineer": { "provider": "deepseek", "model": "deepseek-v4", "reasoningEffort": "high" },
    "reviewer": {}
  },
  "memberMaxTokens": 2000,
  "memberMaxDepth": 1,
  "maxMembers": 6
}
```

- `memberModel` 是全局默认路由（未匹配到角色时回退）；`roleModels` 按角色键（内置角色 + 自定义角色）配置各自的**职责定义**：`name`（显示名）、`description`（职责描述，写入成员 persona）、`provider`/`model`/`reasoningEffort`，**角色匹配优先于全局默认**。
- 内置角色与鲸鱼头像一致：`researcher / engineer / reviewer / qa / designer / security / docs / data / operator`；面板里也可**自己创建角色**（如 `frontend`），为其填写显示名、职责描述与模型路由。
- 角色匹配对成员 `role` 字段做归一化：精确键名优先；其次按「独立单词出现位置最早」匹配（`QA Engineer` → `qa`、`Frontend Engineer` → `frontend`）；最后按包含关系匹配，最长键胜出。匹配到的角色的 `description` 会作为该成员的「Role definition」写进其系统提示。
- `memberModel.provider` 需要与 `memberModel.model` 成对出现（`roleModels` 内同理）；只填 model 时沿用组织者当前 provider。
- `memberModel.reasoningEffort` 为目标模型支持的档位 id，或 `"default"` 表示强制目标模型默认档。
- `memberMaxTokens` 仅在成员**新建**时写入其请求选项；冷恢复的既有成员沿用其持久化路由（不重新应用输出上限）。
- 运行时设置覆盖静态 `memberModel` / `memberMaxDepth` / `maxMembers`；对已存在的成员不追溯生效。

成员路由最终优先级：工具显式 `provider`+`model`/`model`/`reasoning_effort` → 角色匹配路由（`roleModels`）→ 全局默认路由（`memberModel`）→ 静态 `memberModel` 配置 → 组织者当前路由。

## 使用协议

插件提示段会指导模型按协议执行：建团队 → 按角色拉成员 → 拆任务并声明依赖 → 共享调度器自动领取并唤醒空闲成员 → 组织者监控/引导 → 阻塞时先安全转派或接管 → 汇报后 `agent_teams_delete`。成员之间可以直接互发消息，无需组织者中转。成员若在中断、异常结束或进程重启后变成 `idle/ready`，但磁盘上仍持有 `claimed/in_progress` 任务，调度器会撤销旧 capability、生成新 attempt 并重新唤醒同一成员。

### 协作复盘改进（collab retrospective lessons）

协议内置了多 agent 协作复盘得出的改进，避免重犯以下问题：

1. **契约先行 + 契约评审前置**：多实现者 / 共享接口的目标先建「契约任务」（architect 写），再建「契约评审任务」（reviewer 审）作为所有实现任务的依赖——歧义在并行开工前裁决，而不是开工后返工。
2. **契约措辞给「定义式 + 正反示例」**：契约对易误解术语（如"两位小数"的值语义）给出形式化定义，并配合法/非法示例（`12`/`12.3`/`12.30` 合法、`12.345` 非法），消除多义解读。
3. **任务描述与契约一致性**：组织者创建任务时按契约复核转述，契约是唯一接口来源；任务描述与契约出入时以契约为准并上报，成员不得擅自发挥。
4. **环境约束前置**：团队创建时在描述中写明已知环境约束（如沙箱对 `tempfile` 嵌套写的限制、平台特性），成员开工前即知，避免现场排查。
5. **收尾清理**：汇报前由成员清理临时产物（临时目录、草稿文件），交付后工作区整洁。

## 已知限制

- 调度是事件驱动而非常驻轮询；组织者离线时无法冷恢复成员，任务和消息保留在磁盘，待组织者恢复或调用状态工具后继续投递。
- 一个组织者同时只能带一个团队（与 Claude Code AgentTeams 一致）。
- 成员 persona 替换部署默认 persona；成员仍拥有完整工具集（bash/fs/web 等）。
- 团队状态为文件级持久化，多进程同时操作同一团队不保证一致（同一 dsh 进程内已用锁串行化）。
- 活动面板读磁盘真相，与会话日志事件流相互独立：切换/重启后先对当前会话做一次冷发现；仅在发现活动团队或存在对话流卡片需求时保持 1s 轮询，普通会话不会常驻扫描。
- 右上角浮层挂载到 DeepSeek Harness `0.1.0-rc.8` 的 `shell.overlay`；宽屏停靠态让主对话列按面板实际宽度礼让空间，浮动态保持非模态覆盖，窄屏退回安全内边距 overlay 并关闭拖拽/缩放，左侧导航保持不动。
- 成员（模型）不总是严格走工具"仪式"（如完成时不调 `agent_teams_update_task`）——面板如实反映磁盘真相，组织者以 `agent_teams_status`/文件为准汇总。

## 验证

- 离线与生命周期：`pnpm build && pnpm typecheck && pnpm verify`。除基础检查外，还包含 8 成员、31 节点多层 DAG（运行中扩展至 38 任务）的故障矩阵：并发接管/移除、50 次迟到写入、4 个开放任务冷重启、7 路认领竞争、40 次终态覆盖、42 条消息突发和最终归档；组合验证 `dsh --profile agent-teams-check --dump-config`
- 真实 e2e：`dsh plugin --profile headless add <path>` 后 `dsh --profile headless "用 AgentTeams …"`，核对 `.agent-teams/` 状态文件与会话日志事件流
- GUI：独立实例 + ego-browser（详见 `verification-guide.md`）
