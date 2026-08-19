---
title: "从 OMO 的局限出发：用 Claude Code 与 Codex CLI 设计原生 Agent 控制平面"
published: 2026-08-19
description: "保留 Claude Code 与 Codex 的原生会话能力，用确定性控制平面组织规划、审核、执行、Skill 和长期记忆。"
tags:
  - "AI Agent"
  - "Claude Code"
  - "Codex"
  - "Rust"
category: 技术实践
draft: false
---

最近重新比较 Claude Opus 5、Claude Fable 5 和 GPT-5.6 Sol 时，我逐渐发现，单独讨论哪个模型更强已经失去了一部分意义。它们的能力分布不同：有的适合长时间编码，有的适合计划和架构推演，有的适合审查难点。更自然的用法，是让它们在一条受控流程里各自承担合适的阶段。

我想要的工作流大致如下：

~~~text
GPT-5.6 Sol 产出计划初稿
    ↓
Claude Fable 5 审核并压缩结论
    ↓
人工确认
    ↓
Claude Opus 5 在长期会话中编码
    ↓ 遇到无法推进的卡点
Claude Fable 5 诊断
    ↓
恢复原来的 Opus 会话继续执行
~~~

这里的“恢复原会话”很重要。编码 Agent 已经了解仓库、执行过命令、看过测试结果，也可能形成了尚未写进文档的局部判断。每次卡住都新建一个角色，会不断支付上下文重建成本，也容易让新 Agent 推翻已经验证过的事实。

## 从非交互式 CLI 开始

Claude Code 和 Codex 都提供非交互式调用能力，可以被上层程序启动、读取结构化输出并保留原生会话标识。CLI 因此不只适合人在终端中使用，也可以作为本地 Agent Runtime。

这种方式保留了两个产品各自的完整运行环境：项目指令、工具权限、Skill、上下文压缩、会话恢复和供应商自己的执行逻辑。上层程序无需伪装成某个官方客户端，也无需把所有能力重新包装成统一的模型 API。

非交互式调用仍有一些工程问题需要处理。结构化输出中会混合文本增量、工具调用、权限请求、错误和最终结果；中断进程后还要区分正常取消、执行失败和可恢复暂停；恢复时必须使用正确的原生 session ID。上层适配器可以统一这些生命周期事件，但不应该抹平 Claude Code 与 Codex 的内部语义。

例如，控制器真正需要的公共事件很少：

~~~json
{"type":"session_started","runtime":"claude","session_id":"..."}
{"type":"text_delta","content":"..."}
{"type":"tool_call","name":"Bash","arguments":{}}
{"type":"permission_request","operation":"..."}
{"type":"completed","result":"..."}
{"type":"failed","reason":"..."}
~~~

## ACP 解决的是连接，尚未解决协同

Zed 等编辑器采用的 Agent Client Protocol 解决了编辑器与 Agent 之间的连接问题。编辑器可以通过统一协议展示对话、工具活动和权限请求。

这层协议没有规定 Claude 和 Codex 应该怎样共同完成一次任务，也没有定义计划审核、人工闸门、单写者约束和卡点升级。ACP 可以成为客户端接入层，跨 Agent 工作流仍需要单独的控制平面。

## OMO 为什么看起来接近，实际体验却不同

OMO 具备主 Agent、子 Agent、模型路由、后台任务、Skill 和 Memory，组件列表与目标系统很像。差异来自 Agent 身份的定义。

OMO 当前以角色和 category 组织工作。每个角色拥有首选模型和 fallback chain。同一个 Sisyphus 角色可以在模型不可用时依次落到多个差异很大的模型。它的[功能文档](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/reference/features.md)也将 category 描述为模型、温度和 prompt mindset 的组合。

这套结构首先解决模型可用性。它的[模型解析流水线](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/packages/model-core/src/model-resolution-pipeline.ts)按 UI 或用户覆盖、category 默认值、fallback chain 和系统默认值依次选择模型。模型选择成功，并不代表计划、审核和执行按指定顺序发生。

我需要的 Agent 身份包含以下完整状态：

~~~text
runtime + model + native session + tools + permissions + skills + workspace
~~~

如果 Opus 执行失败，控制器不能静默换成 GPT 或 Kimi 后继续扮演同一个角色。它应该明确暂停这个 Opus 会话，创建一个 Fable 诊断任务，再把诊断结果交还给原会话。

调度权也需要从主模型手里收回来。模型可以提出“建议进入执行阶段”，控制器必须检查计划产物、审核结论、用户批准和 workspace 写锁。检查全部通过后，状态才从 WAIT_USER_APPROVAL 进入 EXECUTE。这使审核成为可验证的闸门，不再依赖 prompt 中的一句要求。

## Skill 需要一半是文本，一半是契约

动态 Skill 很容易退化成动态 prompt 注入。系统发现几十份 SKILL.md，根据名称或描述挑选几份塞进上下文，然后希望模型完整遵守。随着 Skill 增长，冲突、遗漏和上下文污染也会增加。

更可靠的 Skill 应包含两层。第一层供控制器读取，包括触发条件、适用阶段、权限、前置条件和完成检查。第二层供模型阅读，包括领域知识、操作方法和判断原则。

以 TDD 为例，控制器可以强制记录以下状态：

~~~text
测试骨架完成
→ 用户确认覆盖范围
→ 验证 RED
→ 开放实现修改
→ 验证 GREEN
~~~

模型可以申请加载额外 Skill。控制器负责检查 Skill 是否存在、当前阶段是否允许，并记录实际加载的文件版本。这样才能回答一个重要问题：本次结果究竟遵循了哪一版 Skill。

## 全局记忆需要拆成不同层次

把所有历史压进一个“全局记忆”会制造新的不确定性。用户偏好、仓库规则、当前任务状态、Agent 对话和历史经验拥有不同的权威性与生命周期。

一种更清楚的划分是：

~~~text
SQLite
├── workflow state
├── native session registry
├── artifact registry
└── append-only event log

仓库文件
├── AGENTS.md / CLAUDE.md
├── ADR 和设计文档
└── 当前任务交接材料

原生 CLI
└── 各自的会话上下文

检索系统
└── 按需搜索历史任务、Skill 和文档
~~~

SQLite 中的工作流状态是权威事实。Markdown 面向人和 Agent 阅读。Claude 与 Codex 各自维护原生对话上下文。历史经验只在需要时检索，不能默认注入每个 prompt。

第一版可以直接使用 SQLite FTS5。编码任务中最有价值的线索通常是符号名、错误信息、文件路径、issue 和 commit，这些内容适合全文搜索。等到关键词检索确实无法召回语义相关材料时，再增加 Embedding。

## Rust 控制平面与 Python Agent 生态可以共存

我更偏好 Rust，也希望复用 LlamaIndex 或 LangGraph 的成熟能力。合理的边界是让 Rust 掌握操作系统层面的事实，让 Python 框架提供推理和检索能力。

~~~text
                         CLI
                          │
Tauri / Web / Mobile ─ Rust agentd
                          ├── Claude Code
                          ├── Codex
                          └── Python sidecar
                              ├── LangGraph
                              └── LlamaIndex
~~~

Rust agentd 负责进程监督、会话、状态迁移、权限、工作区锁、SQLite 和流式事件。tokio、axum、serde、sqlx 和 tracing 已经能覆盖第一版的大部分需求。

LangGraph 适合表达 evaluator-optimizer、结构化推理和需要暂停的子图。它本身提供 checkpoint、interrupt/resume 和 human-in-the-loop，[官方文档](https://docs.langchain.com/oss/python/langgraph/persistence)将这些能力建立在线程和持久化检查点之上。这里要避免 Rust 与 LangGraph 同时成为工作流权威。LangGraph 返回建议和产物，Rust 验证后执行真实状态迁移。

LlamaIndex 更适合实现 memory.search()、skill.search() 和 artifact.search()。它可以索引历史任务、设计文档和 Skill，却不负责启动 CLI、分配写权限或保存权威 session 状态。

这个边界保留了成熟生态，也避免把系统生命线交给一个围绕模型 API 设计的框架。

## 桌面、Web 和手机应共享一个后端

长期任务不应该依赖某个 UI 窗口存活。agentd 作为常驻进程继续执行，CLI、桌面端和手机端只是客户端。

Tauri 2 支持桌面、Android 和 iOS，也允许复用 Web 前端。第一版可以先做响应式 Web 或 PWA，通过局域网或 Tailscale 查看实时输出、批准计划、回答问题和中断任务。桌面端再用 Tauri 包装同一套前端。

Slint 很适合全 Rust 原生桌面和移动客户端，我也有参与其生态的动力。不过 Slint 的 Web 后端通过 Canvas 和 WebGL 渲染，不使用 DOM；其[官方文档](https://docs.slint.dev/latest/docs/slint/guide/platforms/web/)也说明它目前不推荐用于一般用途的 Web 应用。若同时维护 Slint 原生客户端和标准 Web 页面，就会产生两套 UI。

手机现阶段主要用于观察和审批，响应式 Web 的成本最低。等到需要原生通知、文件访问、离线能力或更深入的 Slint 集成时，再增加移动客户端。

## 第一阶段只验证一条完整链路

最容易犯的错误，是一开始实现动态路由、向量记忆、Agent 市场、十几个角色和自动 fallback。基础流程尚未可靠时，这些功能只会扩大故障面。

第一阶段只需验证：

~~~text
Sol 规划
→ Fable 审核
→ 人工批准
→ Opus 长期执行
→ 卡点暂停
→ Fable 诊断
→ 恢复原 Opus session
~~~

每一步记录真实 CLI、模型、session ID、输入产物、输出产物和退出原因。控制器能够在进程崩溃、UI 断线和人工等待之后恢复这条链路，系统的核心价值就已经成立。
