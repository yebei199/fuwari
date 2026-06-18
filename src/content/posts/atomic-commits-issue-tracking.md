---
title: "171 个提交比一个巨型提交更可靠"
published: 2026-06-18
description: "Crawle ECS 重构中的原子提交、issue 拆分和长时间任务协作经验。"
tags:
  - "Git"
  - "Issue Tracking"
  - "协作"
category: 技术实践
draft: false
---

这次 Crawle 重构相对 `master` 有 171 个提交。这个数字本身不是目标，但它体现了一种工作方式：把长期重构拆成可验证、可审计、可回滚的逻辑单元，而不是在最后压成一个巨型提交。

如果这次工作只有一个提交，review 基本不可行。它会同时包含 schema 重写、API 新增、RabbitMQ adapter、worker 状态机、Zhihu 迁移、YouTube 迁移、legacy 清理、migration CLI、source-boundary tests、smoke tests 和大量 validation hardening。任何一个测试失败，都很难定位是哪一类变化造成的。任何一个风险需要回滚，也只能回滚全部。

原子提交不是 Git 洁癖。对 20 小时级别的大重构来说，它是风险控制。

## Issue 先给大任务分阶段

这次正式实现前先创建了 parent tracking issue，再按阶段拆 child issues。阶段包括 persisted ECS runtime kernel、RabbitMQ outbox adapter、Zhihu ECS systems、legacy migration、real Postgres/RabbitMQ smoke gate、YouTube legacy route shim removal 等。issue 的作用不是装饰项目管理，而是给长期任务设置可完成边界。

没有 issue 边界，大重构很容易变成“顺便再改”。看到一个旧 helper，顺手删；看到一个测试不顺眼，顺手重写；看到一个 API 缺字段，顺手补。这些动作可能都合理，但如果没有阶段目标，最后很难判断当前到底完成了什么、剩下什么、哪些风险被接受。

issue 的价值在于把“完成”写成可讨论对象。每个 child issue 都应该有范围、实现证据、验证命令和剩余风险。关闭 issue 时，不是写一句 done，而是说明哪些路径已经迁移、哪些测试通过、哪些 smoke 是 opt-in、哪些 live 验证被明确豁免。

## 原子提交的单位是意图，不是文件数量

好的原子提交不是“文件越少越好”，而是“意图单一”。一个 API endpoint 可能需要改 route、store、test、README 和 changelog，只要这些文件都服务同一个行为变化，就是一个原子提交。反过来，一个文件里两个无关修复，也应该拆成两个提交。

例如 `fix(worker): preserve retryable command jobs` 处理的是 retryable system error 的状态语义：recoverable error 保留 job queued、增加 attempts、返回 retry；non-retryable job data error 标记 failed 并 ack。它不混入 migration 逻辑，也不顺手改 API。这个提交可以单独理解、单独验证。

再如 `feat(migration): map legacy youtube videos` 只扩展 legacy migration 对历史 `youtube_video` rows 的映射，补测试、README 和 changelog。它的边界也清楚：把历史 YouTube video rows 转成 `youtube_channel_video` ECS raw items，并使用现行系统一致的 hash identity。

这就是原子提交的标准：读 commit message 能知道目的，读 diff 能看到所有改动都支持这个目的，跑相关测试能验证这个目的。

## 大提交会掩盖设计决策

这次有不少重大取舍，如果混在大提交里会被淹没。比如 YouTube route shim 删除是 breaking change；知乎 QR/feed live smoke 被明确豁免；真实 Postgres/RabbitMQ 长期可靠性不进默认门禁；Crawlee 保留为 browser adapter 而不是全局任务队列；没有为了名词完整添加空 `World` 类。

这些取舍本身就是工程经验。它们需要在 issue、commit 和 change log 里留下证据。否则后续维护者只会看到结果，看不到为什么这么做。

例如删除 shim 的 commit 使用 `refactor(youtube)!`，感叹号告诉读者旧 import path 不再可用。如果把这个删除混在一个“large refactor”提交里，外部脚本 import fail 时很难追溯原因。

## Change log 是跨提交的叙事层

commit 适合记录一个逻辑单元，但不适合讲完整过程。于是这次维护了 `docs/change_log/2026-06-17/full-ecs-crawler-refactor.md`，记录 purpose、scope、implementation process、key diff、verification、difficulties、final result 和 risks。它像一份工程审计报告，把多个提交之间的关系串起来。

这份 change log 记录了很多 commit message 不足以承载的信息：Prisma schema engine 在 NixOS 上需要 `PRISMA_SCHEMA_ENGINE_BINARY`，旧 Prisma model 删除后短期出现 legacy delegate shim，后来 shim 被移除；YouTube live smoke 暴露 DOM drift，修复后把 `/watch` anchor fallback 固化到测试；service smoke 和 YouTube smoke 跑过临时 Postgres/RabbitMQ，但长期可靠性仍在默认门禁之外。

长任务中用户多次询问“当前进度如何”。如果没有 change log，回答只能依赖短期记忆。对于跨多个小时、上百提交的工作，记忆不可靠，持久记录才可靠。

## 何时立即提交

这次用户明确要求“保持原子性功能 commit，不要一次性提交过多文件在同一个 commit 中”。这个要求很实际。每完成一个独立逻辑单元，并通过对应验证，就应该提交。不要等一天结束再统一提交，因为那时多个逻辑单元已经混在一起。

立即提交的好处包括：

- 失败时能用 git history 定位最近变化。
- 中断或上下文压缩后，后续工作者可以从干净状态继续。
- 每个 issue 的完成证据更清楚。
- 大范围重构不会长期停留在脏工作区。
- 用户可以审阅阶段性结果，而不是面对最终巨型 diff。

当然，频繁提交也需要纪律。不能为了提交而提交半成品；不能把测试和实现拆成两个互相不能独立通过的提交；不能把无关格式化混入行为变化；不能用 `git add .` 把用户未关联改动一起带进去。

## 什么应该放在同一个提交

我会用以下规则判断提交边界：

- 行为变化、对应测试、相关 README/changelog 更新可以在同一个提交，因为它们共同证明一个逻辑单元。
- 纯文档整理可以单独提交，除非它是某个代码变化的同步文档。
- refactor 和 feature 如果能独立验证，应先 refactor 后 feature。
- breaking cleanup 应单独提交，并在 subject 或 footer 明确 breaking。
- smoke test entrypoint 和文档可以同提交，因为使用方式是该能力的一部分。
- 大量 validation 如果各自保护不同边界，应该拆成多个小提交。

这些规则让 history 既不碎成无意义噪声，也不会大到不可审计。

## Issue closing 要写证据，不要写情绪

关闭 issue 时，最有用的信息是：改了哪些路径，验证了哪些命令，哪些测试跳过以及原因，剩余风险是什么。比如“Zhihu QR/feed live smoke 需要真实账号和人工扫码，本阶段用户明确豁免”，这就比“未测试”更准确。又比如“service smoke 通过临时 Postgres/RabbitMQ，但长期可靠性不在默认门禁内”，这说明的是验证层级，而不是逃避验证。

这类记录能减少未来误解。以后有人看到某项 live smoke 没进默认 verify，不会误以为漏做；看到 old YouTube route import fail，也能知道这是已确认的 breaking cleanup。

## 这次的核心经验

长重构需要三个账本：issue 记录计划和阶段，commit 记录可验证变化，change log 记录跨提交的设计取舍和验证结果。少任何一个，20 小时级别的协作都会变得难以追踪。

171 个提交不是为了证明工作量，而是为了让重构历史可审计。一个巨型提交也许能更快“完成”，但它会把所有风险压到最后。原子提交的价值在于让每一步都能回答：为什么改、改了什么、怎么验证、如果错了怎么回退。
