# 审查（Review）功能分析

> 调研时间：2026-09。目标：为桌面版**右侧侧边栏「审查」面板**做方案输入——先厘清市面上各家 harness 的 review 到底是什么、逻辑是什么，再映射到我们的插件体系（上游基线 dsh-v0.1.1-rc.2）。

---

## 1. 「审查」在 AI 编码工具里的三种形态

各家产品里的 "review" 其实是三件不同的事，混在一起谈就会迷惑：

### 形态 A：人审 AI（review the agent's output）

会话结束后/中，**人**逐文件、逐 hunk 审查 agent 改了什么，必要时批注或回退。

- 代表：Claude Code on web/desktop 的 diff 视图（会话列表直接显示 `+42 -18` 指示器）、ZCode 桌面端的「Review changes」按钮、Cline 的 Checkpoints、Codex ChatGPT 桌面版 review pane 的 staging/revert。
- 数据来源：工作区 git diff 或会话流内工具产生的 diff。
- 本质：**一个以 diff 为主的展示层**，加上「批注 → 回灌 agent」的通道。

### 形态 B：AI 审人（agent reviews code）

**让 agent 以审查者角色**跑一遍当前 diff / 指定 commit / PR，输出结构化 findings。

- 代表：Claude Code 的 `/code-review`（`/review` 是它的别名）、Codex CLI 的 `/review`、Cursor 的 Agent Review / Bug Finder、Gemini CLI 的 `/code-review` 扩展、Copilot 在 VS Code 里的 uncommitted changes review。
- 数据来源：git diff + 被改文件全文 + 项目规范文件 + 代码库上下文。
- 本质：**一次独立的、只读的 agent 任务**，产出 findings 而非改动。

### 形态 C：仓库级自动审查（PR bot）

GitHub App / Action 在 PR 上自动审查，输出行内评论。代表：Claude 托管 Code Review 与 `@claude` Action、`@codex review` / Automatic reviews、Copilot PR reviewer、Cursor Bugbot。

- 这是服务端/CI 形态，**不属于桌面端 harness 的主战场**（涉及外部写操作），调研它只为借鉴其输出模型（severity 分级、行内评论、suggested change）。

**关键趋势：A 与 B 正在融合。** 同一个 diff 视图既是人审界面、又是 AI 审查结果的呈现层；行内评论是两者共同的「货币」——人对着行写评论，组装成下一条消息回灌 agent（Claude web 的做法，见 §3）；AI 的 findings 也落成行内评论，再一键触发修复（Copilot / Bugbot 的做法）。

---

## 2. 各家现状

### 2.1 Claude Code（Anthropic）

**本地审查（形态 B）**——`/review` 现在是 `/code-review` 技能的别名：

- 签名：`/code-review [low|medium|high|xhigh|max|ultra] [--fix] [--comment] [pr#|branch|path]`。默认审当前 diff（分支领先 upstream 的提交 + 未提交改动），也可指定 PR 号、分支、路径。
- `--fix` 直接把发现应用为修改；`--comment` 把 findings 发成 GitHub PR 评论；`ultra` 走云端多 agent 深审（ultrareview）。
- 官方实现是 **4 个并行子代理**（2 个查 CLAUDE.md 合规、1 个 bug 检测、1 个 git blame 历史分析）+ 一个独立评分器，每条发现打 0–100 置信分，**低于 80 的被过滤**。
- `/security-review` 单列：审当前分支待提交改动的安全漏洞（注入、鉴权、硬编码密钥、竞态……），输出行级评论 + 严重度 + 修复建议；斜杠命令与 GitHub Action 共用同一套分析逻辑。

**GitHub 集成（形态 C）**：托管版多 agent 审 diff + 全库上下文 → 验证步骤过滤误报 → 按严重度排序的 PR 评论；审查标准写在项目级 `REVIEW.md`；下次 push 会自动解决已修复的 review thread。另有经典的 `@claude` mention 触发版 Action。

**Web/桌面端（形态 A）**：会话列表显示 diff 指示器 → 进入按文件分组的 diff 视图，可对**特定行留行内评论**，评论随下一条消息发给 Claude（以 "at src/auth.ts:47, …" 的形式注入）；可从网页直接开 PR。没有逐 hunk 强制批准关卡——控制手段是权限模式与 plan mode。沙箱侧 git 凭据留在沙箱外，push 由代理以 scoped 凭据代发。还有 Auto-fix PR：订阅 PR 的 GitHub 活动自动推修复。

### 2.2 OpenAI Codex

**CLI `/review`（形态 B）**：弹出**四预设选择器**——

1. Review against a base branch（PR 视角，找 merge base 比较）
2. Review uncommitted changes（staged + unstaged + untracked）
3. Review a commit
4. Custom review instructions（自定义审查指令）

然后**起一个专用 reviewer turn**，产出按优先级排序的 findings，**明确不改工作树**（只读）。可用 `config.toml` 的 `review_model` 让审查用与当前会话不同的模型。

**IDE / ChatGPT 桌面**：VS Code 扩展里 `/review` 仅当项目在 git 仓库内出现（两个 scope）；`chatgpt.reviewDelivery=detached` 可把审查放进独立 review chat。ChatGPT 桌面版 review pane 的 scope 更细（Unstaged / Staged / Commit / Branch / **Last turn**），findings 显示为 pane 内行内评论，支持 staging/revert（整个 diff、单文件、单 hunk 三种粒度）。

**修复闭环**：hover 行 → `+` → 写评论 → 发 "Address the inline comments and keep the scope minimal."，**行内评论被当作审查指引回灌**。GitHub 侧 `@codex review`（或开启 Automatic reviews），只报 **P0/P1**；评论 `@codex fix the P1 issue` 启动 cloud chat，可推回分支。

**配置**：`AGENTS.md` 的 `## Code Review Rules` 一节直接约束 review 行为（根目录仓库级、子目录更具体）。SDK cookbook 给出了**公开的 findings 结构化输出**：`findings[]`（title / body / confidence_score / priority / code_location）+ `overall_correctness`，经 GitHub API 落成行级评论。

### 2.3 Cursor

分三层：

- **Agent Review**：任务完成后点 Review → Find Issues；或在源码管理面板对**本地全部改动 vs main** 跑审查；`@Branch` 可把分支 diff 喂给 agent。输出为编辑器内逐行标记的问题。
- **Bug Finder**：命令面板触发的后台扫描，对相对基线的 diff 找逻辑类 bug（2.0 起取代旧 Review tab）。
- **Bugbot**：独立 PR bot（作为 GitHub check 运行），行内评论 + autofix（直接从 PR 评论 commit 修复）+ Bugbot Rules 团队规范；官方称 70%+ 的 flag 在合并前被解决。

### 2.4 GitHub Copilot

**PR review（形态 C 的标杆）**：Request reviewer / ruleset 自动触发；审查指南走 `.github/copilot-instructions.md`、`AGENTS.md` 等指令文件（**从 head branch 读取**）；Lite/Balanced 两档；评论带 High/Medium/Low 严重度。闭环最强：建议以 **suggested changes** 呈现，两下点击 apply（可批量收进一个 commit）；**Fix with Copilot** 会指挥 cloud agent 修复。

**IDE 内（形态 B）**：选中代码右键 Review；Source Control 面板一键审 uncommitted changes，评论进 Comments 面板并同步 **Problems 标签页**；每条建议可 Apply and Go To Next / Discard。

### 2.5 ZCode（智谱）

桌面级 ADE（非 VS Code 插件）：

- 长任务工作流的**收尾内置 Review 环节**：需求理解 → 计划拆解 → 代码修改 → 验证 → Review 串在同一个任务里。
- 桌面端 **「Review changes」按钮**：以 git diff 形式逐行查看 agent 动了哪几行，配合 checkpoint 可回退到几轮对话前。
- 内置/可自定义 **code-reviewer 子智能体**承担审查角色；CLI 侧无官方 `/review`，但支持自定义 commands 自建。

### 2.6 Kimi Code（月之暗面）

**目前没有专门的 review 功能**：官方 40+ 条斜杠命令里没有 `/review`（也没有 `/commit`）；内置子代理只有 coder / explore / plan（无 reviewer 型）；无 PR/GitHub 集成。审查只能自然语言下发（`kimi -p` 可脚本化），或靠其 skills 机制自装 review skill。**它证明了「没有产品化 review」的 harness 长什么样——这恰好是我们可补位的空间。**

### 2.7 其他（一句话）

- **Gemini CLI**：官方 code-review 扩展加 `/code-review` 斜杠命令（审当前分支改动，支持审 PR），另有 security 扩展。
- **Sourcegraph Amp**：核心是 **Oracle**——只读子代理，专做审查/分析/第二意见，主 agent 可随时调用。
- **Aider**：没有 review 命令，靠 auto-commits（每次编辑自动 commit）+ `--show-diffs` 让改动天然可审、可回滚。
- **Cline**：Checkpoints（改文件/跑命令前自动快照，可回滚对比）+ v3.39 的 Explain Changes（改动讲解，可在改动上开评论线程追问）。

### 2.8 横向对比

| 产品 | 本地 diff 审查（B） | PR/仓库级（C） | 输出形式 | 修复闭环 |
| --- | --- | --- | --- | --- |
| Claude Code | `/code-review`（多档强度，4 并行子代理 + 置信过滤） | 托管 Code Review + `@claude` | 终端 findings / PR 行内评论 | `--fix`、Auto-fix PR、web 行内评论回灌 |
| Codex | `/review` 四预设，专用 reviewer，只读 | `@codex review` / 自动审查（P0/P1） | findings 列表 / pane 行内评论 | 行内评论回灌、`@codex fix` |
| Cursor | Agent Review、Bug Finder | Bugbot | 逐行标记 / PR 行内评论 | 同 agent 续修、autofix |
| Copilot | uncommitted changes review（VS Code） | PR reviewer bot | 评论 + Problems 面板 | suggested changes 两击 apply、Fix with Copilot |
| ZCode | 工作流内置 Review + code-reviewer 子代理 | — | git diff 视图 + 对话消息 | 意见直接回对话流 + checkpoint 回退 |
| Kimi Code | ✗（仅自然语言） | ✗ | 普通对话 | 通用对话续修 |

---

## 3. 共性提炼：审查功能的通用流水线

把各家做法抽掉外壳，review 逻辑是一条六段流水线：

```
① 选范围 scope → ② 收数据 → ③ 跑审查（独立 reviewer）→ ④ 降噪 → ⑤ 呈现 findings → ⑥ 处置闭环
```

**① Scope 四预设是行业共识。** Codex 的菜单、Claude 的参数、Cursor 的 "vs main"、Copilot 的 uncommitted review 全部落在这四类：**base branch（PR 视角）/ uncommitted / 指定 commit（或 PR）/ 自定义指令**。桌面端照抄这组预设即可，无需发明。

**② 数据 = diff + 意图上下文。** 光有 diff 不够——各家都注入项目规范文件（CLAUDE.md / AGENTS.md 的 `## Code Review Rules` / REVIEW.md / copilot-instructions.md）和代码库上下文（blame、关联组件）。审查者需要知道「这段改动想干什么」才能审得准。

**③ 审查者必须是独立角色，不是主 agent 自审。** Codex 起 dedicated reviewer turn；Claude 用 4 个并行子代理 + 独立评分器；Amp 干脆做成只读的 Oracle。独立性同时保证了**只读纪律**（Codex 明确 review 不改工作树）与视角去偏。

**④ 降噪靠过滤，不靠模型自觉。** Claude 按置信分 ≥80 截断、Codex 只报 P0/P1、Copilot 分 High/Medium/Low。共同点：宁可少报， findings 必须可执行。

**⑤ 呈现 = 结构化 findings，行级锚定。** Codex SDK cookbook 给出的公开数据模型可作为行业参照：

```
findings[]: { title, body, confidence_score, priority, code_location(file, line) }
overall_correctness: { score, confidence }
```

**⑥ 处置闭环的本质：行内评论是审查与修复之间的通用货币。** 人审（Claude web：行内评论组装成 "at src/auth.ts:47, …" 的下一条消息）与 AI 审（`@codex fix`、`--fix`、Fix with Copilot）殊途同归——**每条 finding 都要能一键变成发给 agent 的修复任务**，否则审查只是份报告。

---

## 4. 落地到桌面版

> **定位更新**：审查功能选型已确定为**形态 A（人审 agent 改动）**，本节保留的 A+B 融合设计仅作长期愿景；逐项功能清单与分期验收见 [review-feature-list.md](review-feature-list.md)。

### 4.1 能力面盘点（我们已有什么）

| 需求 | 现状 | 结论 |
| --- | --- | --- |
| 右侧面板容器 | `patches/0006` 已把 ui-layout 改为四列 + `panel` 槽；`@dsh-desktop/panel-shell` 占列并提供多 tab 页（`panelShell.registerPage`）；0007 已把轨迹视图迁入作先例 | **零新增缝**，review 面板页直接注册 |
| 会话内 diff 数据 | 上游 `tool-fs` 对每次 write/edit 计算 hunk（`FsDiffMeta`），挂工具结果 meta，随 session 持久化；客户端有 `DiffBlock` 原语 | 形态 A 的会话级改动汇总，client 半即可做 |
| 工作区 git diff | 上游 **没有** git/文件读 RPC | 需 host 半插件挂自有只读路由（file-browser、archive-manager 先例） |
| 触发审查 | 上游**没有** `/review` 命令 | host 半插件 `ctx.commands.register()` 可加（注意 agent 上下文注册时机）；client 半只能用 ui-commands 做输入侧装饰 |
| transcript 读取 | `sessions.history` RPC（分页）+ mux 事件流；activity-group 有解析会话节点流的先例 | client 半可取审查产出 |
| 子代理 | 上游有 `subagents.*` RPC | 独立 reviewer 角色有望复用（细节待验证） |

### 4.2 设计：面板页承载形态 A + B

新增插件 `@dsh-desktop/review`（双面包），右侧「审查」面板页，**同时是改动视图（A）与审查结果视图（B）**——这正是 §1 说的融合趋势：

```
┌─ 审查面板 ────────────────────────────┐
│ scope: [未提交改动 ▾]   [开始审查]      │  ← 四预设（MVP 先做两个）
│ ────────────────────────────────────│
│ ▼ src/auth.ts        3 findings      │  ← findings 按文件分组
│   ● high  #12 竞态：token 刷新未加锁   │     行级锚定
│   ○ low   #13 命名不一致               │
│ ▼ packages/webui/…                   │
│ ────────────────────────────────────│
│ [修复 #12]  [忽略]                    │  ← 一键回灌会话
└──────────────────────────────────────┘
```

两条数据链路：

1. **diff 链路**：host 半挂 `{ kind: 'exact', path: '/dsh-desktop/review/diff' }` 只读路由，服务端跑 `git diff`（scope 决定参数；沿用 archive-manager 的同源校验三重防线）。client 半拿 diff 做底图。
2. **审查链路**：面板「开始审查」→ 经 `sessions.prompt` 发 `/review <scope>`（host 半注册的命令，四预设）→ 命令起独立 reviewer（子代理/专用 turn，只读）→ 产出**约定格式的 findings**（JSON 代码块或专属 markdown 标记，随 assistant 消息进 transcript）→ client 半从会话事件流解析渲染（activity-group 先例）。

**产出解析选「会话流解析」而非「落盘 + 自有路由」**：零额外存储、天然进 transcript 可重放、与 agent 修复循环同源（review 是会话的一部分）。模型输出不规范时退化为原文展示即可。

### 4.3 分阶段路线

- **MVP**：`/review` 命令（scope：uncommitted + base branch）→ findings 解析渲染（severity 分组、文件折叠、行号锚定）→ 「修复此项 / 忽略」按钮回灌会话。diff 底图可后置（先只出 findings 列表，点 finding 用 0008 的 Inspect/panel 交接缝跳详情）。
- **v1**：diff 底图内嵌（findings 行级锚定到 diff hunk）；会话级 FsDiffMeta 改动汇总页（形态 A，不依赖 git 仓库也能用）；自定义审查指南（读仓库内的 review 规则文件，对齐 AGENTS.md / REVIEW.md 惯例）。
- **明确不做**：GitHub PR bot / 自动发评论（外部写操作，触发红线）；云端深审。

### 4.4 findings 数据模型草案

```ts
interface ReviewFinding {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  file: string
  startLine: number
  endLine?: number
  title: string
  body: string            // 问题描述与依据
  suggestion?: string     // 修复建议（可整体回灌）
  status: 'open' | 'fixing' | 'resolved' | 'dismissed'
}
```

`status` 由 client 半维护（会话内内存态即可，v1 再考虑持久化）；「修复此项」= 把该 finding 序列化成一条会话消息。

### 4.5 边界自检

- 不改上游：面板走既有 `panel` 缝 + panel-shell；diff 走插件自有路由；命令走 host 半插件注册。**预计零新补丁**（待实现时验证 `subagents.*` 细节）。
- 只读纪律：审查路由只 `git diff`/读文件，不做写操作；审查本身不发任何外部请求。
- 插件间复用：diff 路由可考虑抽到 shared 常量（学 archive-manager 的 `src/shared.ts` 防漂移），file-browser 的只读文件读取逻辑可部分复用。

---

## 5. 参考资料

**Claude Code**：[Commands（/code-review、/security-review）](https://code.claude.com/docs/en/commands) · [Code Review](https://code.claude.com/docs/en/code-review) · [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) · [code-review 插件实现](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md) · [security-review](https://github.com/anthropics/claude-code-security-review) · [ultrareview](https://code.claude.com/docs/en/ultrareview)

**Codex**：[Code review 总览](https://learn.chatgpt.com/docs/code-review) · [CLI /review](https://learn.chatgpt.com/docs/codex/cli) · [IDE 扩展](https://learn.chatgpt.com/docs/codex/ide) · [GitHub 集成（@codex review/fix、AGENTS.md 规则）](https://learn.chatgpt.com/docs/third-party/github) · [SDK review cookbook](https://developers.openai.com/cookbook/examples/codex/build_code_review_with_codex_sdk)

**Cursor**：[Reviewing & testing](https://cursor.com/learn/reviewing-testing) · [Bugbot](https://cursor.com/bugbot) · [Changelog](https://cursor.com/changelog)

**GitHub Copilot**：[Using Copilot code review](https://docs.github.com/copilot/using-github-copilot/code-review/using-copilot-code-review) · [Code review agents](https://docs.github.com/copilot/concepts/agents/code-review)

**ZCode**：[官网](https://zcode.z.ai/cn) · [文档](https://zcode.z.ai/cn/docs/welcome) · [Q&A](https://zcode.z.ai/cn/docs/qa)

**Kimi Code**：[仓库](https://github.com/MoonshotAI/kimi-code) · [斜杠命令参考](https://moonshotai.github.io/kimi-code/zh/reference/slash-commands.html) · [使用指南](https://www.kimi.com/code/docs/kimi-code-cli/guides/getting-started.html)

**其他**：[Gemini CLI code-review 扩展](https://github.com/gemini-cli-extensions/code-review) · [Amp Oracle](https://ampcode.com/news/oracle) · [Aider git 文档](https://aider.chat/docs/git.html) · [Cline Checkpoints](https://docs.cline.bot/core-workflows/checkpoints)
