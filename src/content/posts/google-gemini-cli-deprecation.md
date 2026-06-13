---
title: Google 废弃 Gemini CLI：产品性死亡与开源漏斗策略
published: 2026-06-13
description: Google 切断个人用户后端，将 Gemini CLI 降级为企业附属品，未来入口迁往闭源 Antigravity CLI——这是开源漏斗策略的教科书案例。
tags: [Google, AI, 开源, CLI]
category: 技术观察
draft: false
---

## 判断：不会立刻废弃，但会产品性死亡

按 Google 目前公开说法，`google-gemini/gemini-cli` 不会在 **2026-06-18** 直接删除或归档。官方明确说：企业客户、Gemini Code Assist Standard/Enterprise、Google Cloud 路径、付费 Gemini / Gemini Enterprise Agent Platform API keys 仍然可以继续使用 Gemini CLI，并且会继续获得最新 Gemini 模型和其他更新。

但对个人用户来说，它基本会 **产品性死亡**。官方公告写得很清楚：从 **2026-06-18** 起，Gemini CLI 和 Gemini Code Assist IDE extensions 将停止为 Google AI Pro、Ultra，以及免费个人用户提供请求服务。个人用户入口被迁到 Antigravity CLI。

所以不是"仓库立刻废弃"，而是更恶心的形态：

> 仓库还活着，代码还可能更新，但核心用户群被切走；
>
> 开源社区继续看到一个壳，真正的未来产品入口变成闭源/半闭源的 Antigravity。

## "社区自己维护"可能性很低

理论上，社区可以 fork Gemini CLI。现实上，fork 的价值有限，因为这类 CLI 的核心不是 TUI 代码，而是 **认证、额度、模型路由、服务端 agent harness、策略风控、上下文服务**。Google 现在迁移的理由正是要把 Gemini CLI 并入 Antigravity 的统一后端和 server-side harness。

也就是说，社区最多能维护：

* 终端 UI
* 本地工具调用
* prompt / session / config 逻辑
* API key 模式下的适配层

但社区维护不了：

* Google AI Pro/Ultra 的 OAuth 额度
* 免费个人用户 quota
* Gemini Code Assist 的后端授权
* Antigravity 的多 agent 后端
* Google 的风控与账号策略

所以"社区接手"不会变成真正意义上的替代品。它更可能变成一个 **BYO API key 的开源 Gemini terminal client**。如果 Google 继续保留 paid API key 访问，它还能活；如果以后 API 协议或模型权限继续向 Antigravity 倾斜，它会逐渐萎缩。

## Google 当前没有给出"开放 Antigravity CLI"的承诺

社区已经有人直接提 issue 问：Antigravity CLI 是否开源？提问者也明确指出社区投入了大量人力打磨 Gemini CLI 的 UI/UX 和边缘问题，希望 Antigravity CLI 继续保持开源精神。这个 issue 目前只是被标为 documentation/question/backlog，没有看到官方给出"Antigravity CLI 会开源"的明确承诺。

这点很关键。Google 不是把旧项目平滑升级为新开源项目，而是：

1. 先用开源 Gemini CLI 聚集用户、贡献者、stars、生态反馈。
2. 再宣布个人入口迁到 Antigravity CLI。
3. 新 CLI 不是同等开源形态。
4. 旧仓库保留给企业/API key 路径，避免被指控"完全关闭"。

这是一种典型的 **开源漏斗策略**：开源负责吸附社区动能，商业闭源产品负责承接未来控制权。

## 你的判断基本成立：社区人力被抽走了

Google 自己在公告里承认 Gemini CLI 有超过 **100,000 GitHub stars、6,000 merged pull requests、数百名贡献者**。这说明它不是一个没人用的实验项目，而是已经吸收了大量社区测试、bug report、PR、UX 反馈的真实开源项目。

然后 Google 的措辞是"用户需求已经超出 2025 年早期形态""我们要把精力集中到单一产品 Antigravity"。从公司角度这可以解释成产品整合；从开源社区角度，这就是把社区打磨出来的路径迁移到一个控制权更集中的新平台。刀柄换了主人，刀刃还是社区磨出来的。

更差的是，社区已经有人要求延长 Gemini CLI OAuth 支持，理由是 Antigravity 还不够成熟，强制迁移会破坏付费用户工作流。这说明迁移不是"旧工具自然过时"，而是后端权限被主动切断。

## 后续最可能的状态

概率排序如下：

**最高概率：Gemini CLI 继续存在，但变成企业/API key 工具。**

这符合官方当前表述：企业、Google Cloud、paid API key 不受影响。仓库继续更新，但个人用户生态被抽干。

**中等概率：社区 fork 出一个更干净的 Gemini API CLI。**

但它不会恢复 Pro/Ultra/free OAuth 额度，只能服务 API key 用户。对普通用户吸引力会明显下降。

**中低概率：Google 未来开源 Antigravity CLI。**

目前没有承诺。并且 Antigravity CLI 与桌面端、server-side harness、后台多 agent 架构绑定，开源难度和商业阻力都更大。

**低概率：Gemini CLI 被完整交给社区自治。**

因为 Google 还要保留企业/API key 通道，不太可能完全放手。更可能是名义开源、实际产品路线由 Google 控制。

## 结论

Google 不是"一口气废弃仓库"，而是 **切断个人用户后端，把开源项目降级为企业/API-key 附属品，再把未来入口迁到 Antigravity**。这比直接归档更阴湿：表面上开源项目还活着，实际上最有价值的用户、额度、认证和产品方向都被转移了。

对个人用户来说，策略很简单：不要把长期 workflow 建在 Gemini CLI 的个人 OAuth 路径上。要么把它当短期工具；要么只按 API key 客户端评估；要么直接转向 Codex/Claude Code/OpenCode 这类路线。Gemini CLI 现在已经不适合作为长期主力基础设施。

---

## 附：开源社区的愤怒——6,000 次贡献被一笔勾销

谷歌在过去近一年的时间里，表现得像一个极其积极的开源倡导者：

* **免费的劳动力：** 有数百名独立开发者为 `gemini-cli` 贡献了超过 **6,000 次 Commit**，合力帮谷歌把一个粗糙的终端 AI 工具打磨得极其流畅，完善了 `Agent Skills`、`Hooks`、`Subagents` 以及丰富的插件生态。在宣布废弃的前几个小时，甚至还有不知情的开发者刚刚提交并被合并了包含 27 个提交的复杂 PR。
* **转手变成商业闭源：** 谷歌在榨干了社区对这个生态的测试、修复和功能迭代后，反手掏出了用 Go 语言重写的、**完全闭源** 的 `Antigravity CLI`。更恶心的是，新工具的底层核心逻辑（Skills、Hooks）全盘继承了开源社区此前贡献的架构智慧。
* **极短的迁移期：** 谷歌只给开发者留了仅仅 **4 周** 左右的窗口期（5月19日宣布，6月18日硬切断）。这直接导致大量将 `gemini-cli` 深度硬编码进自己 CI/CD 自动化流水线的个人开发者，被迫面临迁移或放弃的死局。

谷歌产品经理 Dmitry Lyalin 在 GitHub 的官方讨论区表态：

> *"该项目将继续作为 Apache 2.0 许可的仓库留在社区，不做任何改变。"*

这句话只是公关上的说辞。实际剥离的核心在于 **后端 API 的切断**。虽然代码库保留了 Apache 2.0 协议，但原版的 `gemini-cli` 深度绑定谷歌官方特定后端处理逻辑，没有了服务端的算力和特定接口支持，6 月 18 日后就成了一个无法运行的本地单机空壳。

现在开源社区对这种"先用开源骗贡献，做大之后直接闭源或者转企业版"的套路（业界称之为 *Rug Pull*）已经彻底清醒。社区内部目前有两股力量：

1. **彻底去谷歌化（完全 Fork）：** 尝试剥离谷歌专属后端，重写底层 LLM 适配器，使其变成兼容开放 API（OpenRouter、Claude Code API、OpenAI API）的纯开源终端 Agent 框架。
2. **用脚投票：** 彻底不再信任谷歌的开发工具生态，直接转向社区参与度更高的竞争对手工具。

把 IT 协作看作是一场理性的资源交换本没有错，但谷歌这次的操作，显然是单方面撕毁了与开源社区长期以来默契的信任契约。
