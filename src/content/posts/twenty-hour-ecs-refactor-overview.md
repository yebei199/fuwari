---
title: "20 小时重构之后，Crawle 变成了什么"
published: 2026-06-18
description: "从 171 个提交和一次完整 ECS 迁移里复盘长期重构的节奏、边界和结果。"
tags:
  - "重构"
  - "ECS"
  - "工程复盘"
category: 技术实践
draft: false
---

这次 Crawle 重构不是一次“把某个模块改漂亮”的工作。按当前分支相对 `master` 的统计，它覆盖了 171 个提交，涉及 172 个文件，累计约 20175 行新增和 2703 行删除。这个规模本身不代表质量，但它说明了一个事实：这次变化已经越过普通局部重构，进入了“重新定义运行形态”的范围。

重构前的项目还带着 Crawlee starter 的痕迹。`src/main.ts` 里有示例式爬虫入口，旧数据模型和站点脚本混在一起，部分模块 import 时可能产生真实副作用，浏览器资源、数据库写入、登录 session、抓取结果和任务状态没有一个统一的事实来源。对一次性脚本来说，这种结构可能还能靠人工记忆维护；对长期运行服务来说，它会在失败时迅速变成黑箱。

这次重构的目标不是“引入一个新名词”，而是把 Crawle 从脚本集合改成可恢复、可查询、可审计的爬虫服务。最终形态是：Hono 暴露 API，Postgres/Prisma 保存 ECS 状态，RabbitMQ 承载命令消息，outbox 保证数据库事务和消息发布之间有恢复点，worker 消费命令并运行站点系统，Crawlee/Playwright 退回浏览器执行 adapter 的位置。

## 为什么先改运行形态

很多大重构失败，是因为先从局部抽象开刀。先改一个 parser，先抽一个 helper，先拆一个类，看起来都在进步，但系统的运行形态没有变，旧入口仍然可以绕过新边界。Crawle 当时最需要先解决的是入口问题：谁创建 job，谁发布命令，谁消费命令，谁持久化状态，谁持有浏览器资源。

所以第一阶段的重点是让 `src/main.ts` 不再是 Crawlee 示例入口，而是长期服务的启动点。它加载 env，创建 Prisma-backed ECS store，连接 RabbitMQ message bus，启动 Hono API，启动 outbox publisher，并按配置启动站点 worker。这个变化的价值不在于新增代码，而在于“导入模块”和“启动爬虫”彻底分开。没有这个前提，后续任何测试都会被全局副作用污染。

这一点对爬虫项目尤其重要。爬虫常常从脚本长出来，脚本很容易把执行逻辑写在顶层：import 一个文件就打开浏览器，import 一个 helper 就创建 Prisma client，import 一个 route 就开始跑 Crawlee。这些写法在小项目里方便，在长期服务里会让测试、部署、重试和资源清理全部变得不可控。

## ECS 在这里解决的是状态问题

这次没有照搬游戏 ECS。Crawler-domain ECS 的核心不是帧循环，也不是高频系统调度，而是把状态拆成可恢复的实体和组件。`site`、`account`、`session`、`job`、`request`、`response`、`raw_item`、`worker` 都是实体种类；`job_state`、`session`、`response_capture` 这类状态以组件形式保存，并通过 Zod schema 做边界校验。

这个设计改变了很多后续决策。登录 session 不再是某个 cookie 文件或硬编码变量，而是 session entity/component。二维码不再通过本地图片查看器打开，而是 job artifact。feed 抓取的中间响应不再只存在于 Playwright 回调里，而是 response capture component。抓取结果不再散落在旧表或脚本输出里，而是进入 `EcsRawItem`，用稳定 hash 做去重。

最关键的收益是失败后可解释。一个 job 为什么失败，可以看 job state、system run、latest error 和相关 artifact/raw item；一个 command 为什么没发布，可以看 outbox event 状态；一个 raw item 为什么没有重复写入，可以看 content hash 和唯一约束。相比“脚本跑到一半挂了，日志里找原因”，这是完全不同的工程姿态。

## 队列和 outbox 是服务化的分水岭

重构前，把 Crawlee `RequestQueue` 当全局任务队列似乎很自然，因为它本来就是爬虫框架提供的能力。但长期服务里的任务队列不只是 URL 队列，它还要承载 API 创建任务、状态恢复、worker 重启、消息重复投递、失败重试和 DLQ 语义。Crawlee 可以继续执行浏览器动作，但不应该定义全局任务状态。

因此新路径是 API 创建 job，并在同一个数据库事务里写 job entity、job_state component 和 command outbox event。事务提交后，outbox publisher 发布 RabbitMQ 消息；worker 消费命令，再运行注册好的系统管线。这个流程看起来比直接调用函数复杂，但它解决的是最真实的故障窗口：DB 写成功但 MQ publish 失败，或 MQ 消息到达但 job 状态不存在。

这次后期还修了 RabbitMQ adapter 的几个细节：`channel.publish()` 返回 `false` 不能算成功，普通 channel 不能替代 broker confirm，consumer 需要 `prefetch(1)`，关闭 channel 失败时仍要关闭 connection。这些修复说明服务化不是把消息发出去就完事，而是要能正确表达“发布是否真的成功”。

## 站点迁移不能只迁 parser

知乎是第一阶段重点，因为它包含登录、二维码、session、feed 响应监听和 raw item 解析，正好覆盖爬虫服务的复杂状态。新的知乎路径把登录 QR 变成 artifact，把扫码后的 cookie/session 变成组件，把 feed response capture、parser、dedupe/persist 拆成系统。这样系统可以在测试里注入 fake browser port，也可以在真实 worker 里接 Playwright adapter。

YouTube 的迁移重点不同。它更多是 legacy route、Crawlee adapter、raw store 和页面提取逻辑混在一起。重构把 channel video extraction 和 comment extraction 移到 `src/sites/youtube`，通过窄 browser port 暴露；ECS worker 通过 API/outbox 运行；旧 Crawlee adapter 只作为显式 legacy adapter 留在 site layer。最后旧 `src/routes/youtube/*` shim 被删除，这是一次明确的 breaking cleanup。

这两条路径给出的共同经验是：迁移站点时，不要只迁 parser。真正要迁的是执行所有权、状态所有权和副作用边界。parser 只是其中最容易测试的一块，登录、浏览器生命周期、数据去重、任务状态和旧入口清理才是决定架构是否真的迁移完成的部分。

## 后半段的价值在 hardening

前半段完成了“能跑”的路径，后半段大量提交都在补边界。比如 validate artifact writes、validate entity writes、validate command envelopes、validate message bus inputs、validate outbox publisher options、validate job route params、validate raw item writes、validate component writes。这些提交看起来小，但它们把“调用者应该传对”改成了“边界必须拒绝错输入”。

这次暴露出的很多 bug 都不是主路径问题：取消 job 后 worker 仍继续执行系统，terminal job 收到 stale delivery 后被重放，系统取消 job 后又抛错导致状态被覆盖，service shutdown 在 outbox publish 尚未结束时关闭 bus，artifact/raw item 可以写到不存在或非 job entity 上。这些问题如果不在重构后期被系统性补齐，就会在生产里变成很难解释的脏状态。

因此我对这类大重构的经验是：功能迁移完成只代表设计可行，边界 hardening 完成才代表系统可维护。前者让 demo 通过，后者让故障可恢复。

## 验证要分层，而不是全塞进一个门禁

最终默认门禁是 `bun run verify` 和 `bun run audit`。收尾时 verify 通过，Vitest 覆盖 61 个测试文件、338 个通过用例，另有 2 个 opt-in 文件跳过；Playwright 通过通用用例，知乎人工 live spec 因为没有 opt-in 环境变量而跳过；audit 没有报告漏洞。这个结果说明默认可重复契约通过了，不说明真实世界永远稳定。

真实 Postgres/RabbitMQ、真实浏览器、YouTube 当前 DOM、知乎真实账号扫码属于另一层验证。service smoke 和 YouTube worker smoke 被做成 opt-in，并且有 `just` 入口；知乎 QR/feed live smoke 因为需要人工扫码和真实 session，被明确豁免。长期可靠性则不应该伪装成一次测试能证明，它需要 soak test、监控、告警、日志和故障注入。

把这些层级分开，是这次重构里一个很重要的成熟点。默认门禁必须稳定，否则开发者会绕过；smoke test 必须能跑真实链路，否则系统会缺少落地信心；长期运行必须有运维验证，否则一次通过的 smoke 很容易被误读成可靠性证明。

## 最终结果和真正的经验

最终 Crawle 拥有了 persisted ECS schema、Hono API、RabbitMQ outbox、command worker、Zhihu systems、YouTube systems、legacy migration CLI、source-boundary tests 和 opt-in smoke tests。旧 Crawlee starter 入口、旧 DB singleton、旧 Zhihu cook helper、旧 cookie manager、空 legacy crawler tree、`src/utils/not_categorized` 残余目录和 YouTube route shim 都已经清掉。

这次最值得复用的不是某个具体文件怎么写，而是工作顺序：先确立运行形态，再确立状态真相源，再迁移站点系统，再清理旧入口，再补边界 hardening，最后把验证分层写清楚。如果顺序反过来，先在旧架构里抽象很多 helper，最后很可能只是得到一个更复杂的旧系统。

171 个提交的意义也在这里。它不是为了追求提交数量，而是让每个行为变化、每个边界修复、每个清理决策都有独立证据。对这种 20 小时级别的大重构来说，可审计的历史本身就是工程资产。
