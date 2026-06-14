---
title: Google 废弃 Gemini CLI：产品性死亡与开源漏斗策略
published: 2026-06-13
description: Google 切断个人用户后端，将 Gemini CLI 降级为企业附属品，未来入口迁往闭源 Antigravity CLI——这是开源漏斗策略的教科书案例。
tags: [Google, AI, 开源, CLI]
category: 技术观察
draft: false
---

6 月 18 日，`google-gemini/gemini-cli` 不会凭空消失。仓库还在，代码还可能更新，但对个人用户来说，它已经死了。

Google 官方公告的措辞相当直接：从 6 月 18 日起，Gemini CLI 停止为 Google AI Pro、Ultra 以及免费个人用户提供服务。企业客户、Gemini Code Assist Standard/Enterprise、Google Cloud 路径和付费 API key 路径不受影响。个人用户的入口整体迁往 Antigravity CLI。

这比直接归档仓库更难受——表面上开源项目还活着，实际上最有价值的用户群、认证额度和产品方向都已经被转移走了。

---

## 100,000 stars、6,000 个 PR：社区给谁打工了？

Gemini CLI 不是一个冷僻的内部工具。Google 自己承认，这个项目积累了超过 100,000 GitHub stars、6,000 个已合并 PR 和数百名贡献者。过去将近一年，社区把一个粗糙的终端 AI demo 打磨成了支持 Agent Skills、Hooks、Subagents 和丰富插件生态的成熟工具。

有意思的是，在宣布废弃的前几个小时，还有不知情的开发者刚刚提交了一个包含 27 个提交的复杂 PR，并被合并了——没有人提前告知他们任何消息。

4 周后（5 月 19 日宣布，6 月 18 日硬切断），Google 拿出了 Antigravity CLI：用 Go 重写，完全闭源。新工具的底层核心逻辑（Skills、Hooks 架构）明显承袭了开源社区此前贡献的设计思路，但控制权已经彻底内化。刀刃是社区磨的，刀柄却换了主人。

Google 给出的迁移窗口仅有约 4 周。这对大量将 `gemini-cli` 深度集成进 CI/CD 自动化流水线的个人开发者来说，实际上是一道"迁移或放弃"的死局。

---

## "社区自己维护"为什么行不通

有人提议社区 fork Gemini CLI 继续独立维护。理论上可以，实际价值有限。

这类 CLI 的核心价值从来不在终端 UI，而在后端：认证、额度、模型路由、server-side agent harness、策略风控。社区可以维护 TUI 界面、本地工具调用、prompt/session 逻辑和 API key 适配层，但无法接管 Google AI Pro/Ultra 的 OAuth 额度、免费用户 quota、Gemini Code Assist 后端授权，以及 Antigravity 的多 agent 后端。

换句话说，fork 最多能变成一个 BYO API key 的终端客户端。如果 Google 继续保留 paid API key 访问，它还能用；如果 API 协议持续向 Antigravity 倾斜，它会慢慢萎缩成边缘工具。

社区已经有人直接在 GitHub 提 issue 询问 Antigravity CLI 是否会开源——目前只得到了一个 `documentation/question/backlog` 标签，没有任何实质性承诺。

---

## 开源漏斗：吸附社区动能，再转移控制权

这套打法本身不算新鲜，但 Google 这次执行得相当典型：

用开源项目聚集用户、贡献者、stars 和生态反馈；待项目成熟后宣布个人入口迁往非开源替代品；旧仓库保留给企业/API key 路径，避免被指控"完全关闭"；新平台不受社区约束，产品路线由 Google 内部驱动。

Google 产品经理 Dmitry Lyalin 在 GitHub 讨论区表态：

> *"该项目将继续作为 Apache 2.0 许可的仓库留在社区，不做任何改变。"*

这句话本身没有错，但刻意回避了关键事实：原版 `gemini-cli` 深度绑定了 Google 特定的后端处理逻辑。代码库开源，后端切断——6 月 18 日之后，对个人用户来说就是一个跑不起来的本地空壳。Apache 2.0 的许可证不能让断掉的接口重新工作。

这正是开源社区对这类操作最愤怒的地方，业界将其称为 *Rug Pull*：先用开源建立信任、积累贡献，做大后切换为闭源或企业版，将社区劳动的成果收归私有。

---

## 接下来会怎样

**最可能的走向**：Gemini CLI 继续作为企业/API key 工具存在，仓库按企业需求更新，个人用户生态被抽干。这符合官方当前的表述，也是阻力最小的路径。

**有可能，但前景有限**：社区 fork 出一个更干净的 Gemini API CLI 客户端，但它无法恢复 Pro/Ultra/free OAuth 额度，覆盖面会明显收窄，对普通用户的吸引力会持续下降。

**基本不会发生**：Antigravity CLI 未来开源。它与桌面端、server-side harness 和后台多 agent 架构深度绑定，开源的商业阻力比 Gemini CLI 大得多，目前也没有任何公开承诺。

---

## 结论

如果你还在依赖 Gemini CLI 的个人 OAuth 路径，6 月 18 日是一个硬截止，现在就应该评估替代方案：Codex CLI、Claude Code、OpenCode，或者任何基于开放 API 的开源方案。

Gemini CLI 当前不适合作为长期主力基础设施，不是因为它代码烂，而是因为后端控制权从来不在社区手里。它曾经是一个好工具，只是 Google 选择让它成为一个漏斗，而不是一个承诺。
