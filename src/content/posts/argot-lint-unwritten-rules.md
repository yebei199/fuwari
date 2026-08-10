---
title: "argot:用仓库自己的 Git 历史,给 AI 代码上缰绳"
published: 2026-08-11
description: "解析统计式代码审查工具 argot:不用第二个 LLM 审 LLM,而是从 Git 历史学出仓库从未写成文档的惯例,标出 AI 生成代码的偏离之处。"
tags:
  - "AI 编程"
  - "代码审查"
  - "Rust"
  - "开发工具"
category: 技术实践
draft: false
---

# 问题:AI 写的代码"能过审,但不像你的仓库"

大量用 AI 辅助写代码之后,会遇到一类很难被传统工具抓住的问题:代码类型正确、测试通过、review 也挑不出毛病,但它就是不属于这个仓库——

- 引入了团队从来不用的依赖;
- 重新实现了仓库里已有的工具函数;
- 把函数放进了不该放的模块;
- 顺手删掉或削弱了测试断言。

Linter 和类型检查对此无能为力,因为这些"规则"从来没被写成文档,它们只存在于仓库的历史惯例里。用第二个 LLM 来审第一个 LLM 的产出是一条路,但审查者自己也会幻觉。

[argot](https://github.com/get-tmonier/argot) 选了另一条路,口号是 **"Lint the rules you never wrote down"**:从仓库自己的 Git 历史里统计学习出这些不成文惯例,再用纯统计手段(不是生成式模型)给新代码打分。它的核心论点是:仓库历史是唯一不会幻觉的基线。

# 它检测什么:12 条规则,五大类

| 类别 | 规则 | 检测内容 |
|------|------|----------|
| Voice(语汇) | `foreign-import` | 仓库从没用过的依赖 |
| | `unfamiliar-callee` | 从没调用过的函数或接收者 |
| | `rare-tokens` | 相对仓库"口音"统计罕见的 token 序列 |
| | `convention` | 违反已学到惯例的写法 |
| | `superseded` | 仓库正在淘汰、已声明迁移掉的旧模式 |
| Semantic(语义) | `redundant` | 与已有函数重复的新函数 |
| | `misplaced` | 看起来该放在别的模块的函数 |
| Architecture(架构) | `layering` | 逆着既有分层方向的内部 import |
| Integrity(测试完整性) | `test-deleted` / `test-disabled` / `test-weakened` | 被测代码还在,测试却被删、被 skip、断言被削弱或恒真化 |
| Governance(治理) | `rule-tampered` | 改动删除或削弱了锁定规则 |

其中测试完整性这一组特别针对 AI 编码的高发病:模型为了"让测试变绿",悄悄把断言改成恒真、给测试加 skip。这类改动在 diff review 里很容易被人眼放过。

还支持自定义规则:`.argot/rules/` 下放 TOML 清单加沙箱化的 Rhai 脚本。

# 工作流:基线进 Git,每个 clone 可复现

1. **`argot audit`** —— 零配置试用:在临时 worktree 里拟合历史基线,评估 base 到 HEAD 的净 diff,不动工作区。
2. **`argot init`** —— 正式接入:拟合当前仓库,生成 `argot.toml` 和 `.argot/` 快照(几 MB 到几十 MB),**提交进 Git**。这是个值得注意的设计:学习结果作为仓库资产版本化,每个 clone 无需重新训练就能复现同样的检查,CI 也不依赖任何外部服务。
3. **`argot check`** —— 用已提交的基线给新 changeset 打分,接 CI 或 pre-commit。
4. **`argot status`** —— 按"代码面是否实质变化"判断要不要刷新基线,而不是按提交数或时间。

# 实现:15.6M 参数的嵌入模型,直接编进二进制

argot 是 Rust 单个静态链接二进制,支持 12 种语言(Python/JS/TS/Java/Go/Rust/C#/C++/PHP/Ruby/Pascal/PowerShell)。

语义类检测(`redundant`/`misplaced`)靠一个 15.6M 参数的嵌入模型——从 jina-embeddings-v2-base-code 用 model2vec 蒸馏成静态查表,直接编译进二进制。其余检测靠 token 频率、调用图、结构关系等纯统计证据,**判定环节没有生成式模型参与**。这也是它能做到完全离线(`ARGOT_OFFLINE=1`)、不上传任何代码的原因。

集成方式覆盖得很全:CLI、GitHub Action(`fail-on-hits` 默认关)、pre-commit(advisory 与 gating 两档)、Claude Code 插件(Write/Edit 时自动标 foreign-import,只提示不阻断)、MCP server。

# 值得学习的诚实度

项目在 36 个真实开源仓库上公开了可复现的分检测器基准:foreign-symbol 97.3%、重复实现 93.3%、放置 95.9%、分层 97.1%、测试完整性 93.9%;voice 类误报率在普通已接受编辑上为 0.25%。同时明确声明:这些是分检测器指标,**不是整体产品准确率**,并反复强调 "clean 结果不代表代码正确"——它是概率性的 review 提示,不是正确性证明。

已知短板也写得很清楚:如果错误完全用仓库熟悉的词汇写成,它最不可靠;浅历史、生成代码或 vendor 代码占比高的仓库,拟合质量会明显下降。

工具作者主动划清能力边界、公开误报率而不只是召回率,这在"AI 配套工具"这个营销浓度极高的领域里并不常见。

# 适用性判断

以上信息来自项目文档与其自述的基准数据,我尚未在自己的仓库里实际跑过,以下是基于其设计做的推断:

**适合**:历史较深、惯例稳定、AI 辅助提交占比高的仓库。纯本地、基线进 Git、CI 可复现的设计,对单人项目和小团队都没有额外的服务成本,`argot audit` 零配置就能试。

**不适合**:新仓库(没有历史可学)、惯例本身正在剧烈变动的仓库(基线会把过渡期的混乱学进去)、以及生成代码占大头的仓库。另外它本质是"像不像"检测,不是"对不对"检测——一段完全用仓库惯用词汇写出来的错误逻辑,它抓不到。

项目目前约 20 star、300 余次提交,MIT 协议,处于早期但活跃的状态。是否值得引入 CI 建议先用 `argot audit` 在自己的真实仓库上验证误报水平,再决定。
