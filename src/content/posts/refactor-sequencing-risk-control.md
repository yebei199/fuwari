---
title: "20 小时大重构最重要的是排序"
published: 2026-06-18
description: "复盘 Crawle 上百个提交里的阶段拆分、风险控制和原子提交策略，解释为什么大重构不能只靠最后一次跑通。"
tags:
  - "重构方法"
  - "项目管理"
  - "提交策略"
category: 技术实践
draft: false
---

大重构最容易被低估的不是代码量，而是排序。Crawle 这次 ECS 重构跨了 20 小时、171 个提交、172 个文件。真正让它能收尾的，不是一次性写对所有代码，而是每个阶段都尽量只解决一个层级的问题，并把这个层级的验收证据留下来。

如果顺序错了，大重构会迅速变成泥潭。先迁 parser，旧入口还在，结果新旧路径并存；先抽 browser helper，状态仍然在内存里，失败还是无法恢复；先写 RabbitMQ worker，API 创建 job 没有事务 outbox，消息和数据库状态仍然可能裂开；先删 legacy shim，测试和调用方没准备好，就会制造无意义破坏。

## 第一阶段要先确定运行形态

这次最先要回答的问题是：Crawle 到底是什么进程？答案不是“一个 Crawlee 脚本”，而是“一个长期 Bun 服务”。这个判断一旦确定，后续架构才有方向：Hono 是 API 边界，Postgres/Prisma 是状态真相源，RabbitMQ 是命令传输，worker 是异步执行者，Crawlee/Playwright 是浏览器 adapter。

如果不先确定运行形态，所有局部重构都可能被旧入口绕过。旧 `src/main.ts` 如果仍然是 starter crawler，任何新 API 都只是旁路；模块 import 如果仍然会启动 crawler，测试就无法稳定；Crawlee `RequestQueue` 如果仍然被当成全局任务队列，RabbitMQ/outbox 就只是附加层。

所以第一阶段的目标不是功能最多，而是把入口权收回来。服务启动必须显式，资源创建必须显式，模块导入必须无副作用。这个基础打好后，后续迁移才不会一边建新路一边给旧路让行。

## 第二阶段建立状态真相源，而不是急着迁站点

很多人会先迁最熟悉的站点逻辑，因为 parser 和页面操作最容易看到效果。但 Crawle 这次如果先迁知乎 feed parser，而 ECS store、component schema、job state、artifact、raw item、outbox 还没定下来，迁移结果只会变成“新 parser 写旧状态”。

因此第二阶段先建立 ECS kernel 和 Prisma schema。entity kind、component schema、event/outbox、system run、artifact、raw item、job listing 都要先有基本语义。这个阶段的工作不一定有漂亮 demo，但它决定后续所有站点写入哪里、失败如何解释、任务如何查询。

状态真相源确定后，迁站点才有稳定目标。知乎登录保存 session component，feed response capture 写组件或 raw item，YouTube extraction 进入 site layer 后再通过 worker persist，legacy migration 把旧表数据转入新模型。没有这个顺序，站点迁移只是在移动代码，不是在迁架构。

## 第三阶段迁移最能暴露复杂度的站点

知乎被选为第一阶段重点是合理的，因为它不是最简单路径。它需要登录、二维码、人工扫码、session persistence、feed navigation、response capture、raw item parser 和 dedupe/persist。它能逼出服务架构必须回答的问题：人工动作如何表达，浏览器回调如何持久化，账号状态如何归属，失败状态如何查询。

如果先迁一个只需要 fetch JSON 的站点，系统很容易看起来完成，但一遇到登录和浏览器状态就要返工。复杂站点不是为了增加难度，而是用来验证架构边界是否够真实。

YouTube 的价值在另一个方向。它暴露的是 legacy path、Crawlee adapter、旧 route shim、raw item store 和新 site layer 的边界。迁移 YouTube 之后，问题变成：旧 import path 是否还保留，兼容 shim 是否要删，删除是不是 breaking change，source-boundary test 是否要防止回流。两个站点合起来，才覆盖了“新复杂功能”和“旧路径清理”两类风险。

## 第四阶段不要怕做 breaking cleanup，但要让它有证据

删除旧 YouTube route shim 是一个典型的 breaking cleanup。旧路径如 `src/routes/youtube/comment.ts` 原本只是 re-export 到新路径，但只要外部脚本还 import 它们，删除就会 import fail。这个破坏不是 bug，而是选择：项目是否继续支持旧路径。

坏的 breaking cleanup 是“觉得旧代码丑，所以删了”。好的 breaking cleanup 是先解释兼容层的价值和成本，再确认仓库不应该继续鼓励旧依赖，然后用测试防止旧路径继续被内部引用，最后在 commit 和 change log 里记录这个决定。

这次讨论清楚了：旧 shim 存在的唯一价值是给外部消费者时间迁移；坏处是让新旧边界长期并存，内部代码也可能继续依赖旧 path。用户倾向是不应该依赖旧的，所以删除成为合理选择。这里的经验是，breaking change 本身不坏，没说清楚的 breaking change 才坏。

## 第五阶段专门做 hardening

大重构到“主路径能跑”时，最危险的错觉是以为已经完成。Crawle 后半段大量提交都在 hardening：validate store input、validate artifact writes、validate component kind compatibility、validate command envelope、validate queue options、validate API route params、protect terminal job、fix stale delivery、fix cancellation priority、fix RabbitMQ confirm、fix resource cleanup。

这些改动单看都小，但它们决定长期服务是否会产生脏状态。比如非法 artifact 写入如果不被拒绝，后续 job detail 可能查到错误归属；terminal job 如果能被 stale message 重跑，raw item 可能重复写；outbox publish 如果不等 broker confirm，DB 会提前宣称消息已发布；取消状态如果被 catch block 覆盖，用户意图就丢了。

hardening 必须作为独立阶段规划，而不是“有空再补”。因为架构迁移一定会先追主路径，主路径跑通后才看得见边界洞。把这个阶段预留出来，重构质量会明显不同。

## 第六阶段把验证分层，不要追求一个命令证明世界

最终门禁 `bun run verify` 和 `bun run audit` 需要稳定、可重复、适合默认执行。真实 Postgres/RabbitMQ、真实浏览器、外部网站和人工扫码不适合全部塞进默认门禁。它们会让每次提交都依赖外部世界，最后测试会被跳过。

所以这次形成了分层验证：单元和 contract tests 证明核心语义，source-boundary tests 防止旧路径回流，integration/fake adapter tests 证明 DB/MQ 边界封装，opt-in smoke 证明真实服务链路能跑一次，长期可靠性交给 soak、监控和故障注入。知乎 QR/feed live smoke 因为需要真实账号和人工扫码，被明确豁免。

这个分层比“一切都跑一次”更诚实。一次 smoke 不能证明长期可靠，默认测试也不应该假装覆盖真实账号登录。每层验证回答自己的问题，系统整体才可维护。

## 原子提交是风险控制，不是提交洁癖

171 个提交听起来很多，但它们的价值在于把风险拆开。一个提交迁移 API job 创建，一个提交补 outbox 幂等，一个提交修 RabbitMQ confirm，一个提交删除 legacy shim，一个提交补 source-boundary test。这样回看历史时，可以知道每个行为变化对应哪个证据。

如果把二十小时工作压成一个提交，短期看似省事，长期会损失所有定位能力。出了问题不知道是 schema、worker、adapter、站点迁移还是清理旧路径引入的。代码 review 也只能看一个巨大 diff，很难判断每个决策是否合理。

当然，原子提交不是每改一行提交一次。原子单位应该是“一个可解释的逻辑变化加对应验证”。如果测试和生产代码共同完成一个行为，它们应该在同一提交；如果只是文档补充，可以独立提交；如果删除 shim 和迁移内部 import 是同一个兼容策略，也可以放在一起。关键是提交边界要服务于未来排查。

## 大重构里最容易遗漏的是决策记录

代码能告诉后来者系统现在是什么样，但不一定能告诉他为什么这样。为什么不照搬 Bevy ECS？为什么保留 Crawlee 但不使用 RequestQueue 做全局队列？为什么 API 不直接执行爬虫？为什么删除 YouTube shim？为什么 Zhihu live smoke 可以豁免？这些都是架构决策。

这次 change log、issue、commit message 和博客复盘形成了不同层级的记录。issue 适合追踪阶段目标和完成状态，commit 适合记录具体变更，change log 适合描述最终结构，博客适合提炼经验和取舍。它们不是重复，而是面向不同读者。

尤其是大重构中途，决策很容易被上下文淹没。当天觉得显然的选择，一周后就未必记得。把关键取舍写下来，是降低未来维护成本。

## 下次我会更早做的事

如果重来一次，我会更早建立一页“完成定义”。不是抽象地写“完成 ECS 重构”，而是列清楚：旧 starter 入口删除，API 创建 job 走 outbox，worker 运行系统并落状态，Zhihu login/feed 走 artifact/session/raw item，YouTube legacy 路径完成迁移或明确删除，默认 verify/audit 通过，opt-in smoke 有入口，真实账号 live smoke 是否豁免。

我也会更早建立 breaking change 清单。哪些旧 import path 会删除，哪些旧表只作为 migration input，哪些旧脚本不再是入口，哪些环境变量改名或新增。这样每个 breaking cleanup 都不会在收尾时突然出现。

最后，我会更早把 hardening checklist 写出来。输入校验、状态机、terminal job、cancellation、retry/DLQ、resource cleanup、secret redaction、source-boundary test，这些都不应该等主路径完成后才靠记忆补。

## 排序带来的最终收益

这次重构能完成，不是因为每一步都一开始就确定，而是因为排序让不确定性被限制在局部。运行形态确定后，入口问题不再反复；状态真相源确定后，站点迁移有目标；复杂站点迁移后，架构边界被真实需求验证；breaking cleanup 有证据后，旧路径能被移除；hardening 完成后，系统不只是能跑；验证分层后，完成状态不会被夸大。

大重构不是一场长时间编码，而是一连串风险收敛。排序越清楚，每个提交越能回答“现在降低了哪类风险”。这比最终 diff 好不好看更重要。
