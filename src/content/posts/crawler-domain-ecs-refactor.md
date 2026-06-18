---
title: "把爬虫改成领域 ECS，而不是套一个游戏框架"
published: 2026-06-18
description: "一次长期爬虫重构中，为什么 ECS 概念要围绕可恢复任务、浏览器资源和持久化状态重新设计。"
tags:
  - "ECS"
  - "爬虫架构"
  - "TypeScript"
category: 技术实践
draft: false
---

这次重构里最容易误解的词是 ECS。听到 ECS，很容易想到 Bevy、游戏循环、按 component 查询 entity、系统并行执行、每帧调度和 cache locality。但 Crawle 的问题不是游戏运行时问题，而是长期爬虫服务问题：任务要能恢复，状态要能查询，浏览器资源要能清理，消息发布要能确认，人工扫码要能被 API 表达，旧脚本的 import 副作用要被移除。

因此这次不是“把 Bevy 搬到 TypeScript”。更准确的说法是：保留 `Entity / Component / System / Resource / Event / Schedule` 这些建模思想，但把它们重新解释成 crawler-domain 的运行模型。这个区别决定了后面所有设计取舍。

## Entity：先确定系统里哪些东西需要身份

游戏 ECS 里的 entity 可能是一颗子弹、一个角色、一个粒子。Crawle 里的 entity 是长期服务里需要追踪身份和状态的对象：`site`、`account`、`session`、`job`、`request`、`response`、`raw_item`、`worker`。它们不是为了抽象而抽象，而是为了回答一个问题：失败后我们要以什么 id 找回状态？

`job` 是最明显的 entity。API 创建任务后，用户要能查询它，worker 要能围绕它执行系统，取消要能作用在它身上，artifact/raw item 要能挂在它下面。`session` 也是 entity，因为登录态不是临时变量，它要被保存、验证和复用。`raw_item` 可以作为抓取产物被持久化和去重，后续 API 可以按 job 查看它。

这个建模让状态不再依赖“当前进程是否还活着”。只要 entity id 和组件还在数据库里，服务重启后就仍然知道系统发生过什么。这是长期爬虫服务和脚本最大的区别。

## Component：状态切片必须可验证、可版本化

组件不是随手塞 JSON。`job_state`、`session`、`response_capture`、raw item content 等组件都通过 Zod schema 验证，并且以 versioned JSONB 形式持久化。这样做有两个目的：第一，边界错误尽量在写入时暴露；第二，状态变化有版本历史，不需要依赖日志猜测。

例如 session component 不只是一个 cookie 字符串。它代表某个 account/site 下可复用的登录材料，必须经过 schema validation，不能把任意对象写进去。response capture component 也不只是 Playwright 回调里的一段内存数据，它是 feed 抓取系统和 parser 系统之间的状态契约。

后期补 component-kind compatibility 很关键。一个合法的 `job_state` payload 不应该写到 account entity 上，一个合法的 `session` payload 也不应该写到 raw_item entity 上。schema 验证 payload 形状，entity-kind compatibility 验证状态归属。两者缺一不可。

## System：不是每帧函数，而是可记录的 workflow step

这次系统统一实现 `run(ctx, entityId)`。这看起来简单，但它强制了一个重要边界：系统围绕 entity 运行，并通过 `SystemContext` 获取 store、message bus、browser pool、logger 和 config。系统不应该在模块 import 时启动 crawler，也不应该自己创建全局 Prisma client。

知乎 feed 可以被拆成 response capture、raw parser、dedupe/persist、mark completed。知乎 login 可以被拆成 QR artifact、session capture、session persistence。YouTube channel job 可以被拆成 browser collection、raw item persistence、job state completion。每一步都是可测试、可记录、可中断的系统，而不是一个大函数从打开浏览器跑到写数据库。

这种拆分的收益在取消语义上很明显。scheduler 和 command worker 都补了取消检查：job 在系统之间变成 cancelled 后，后续系统不再运行。如果系统取消 job 后又抛错，取消状态应该赢，worker 可以记录 system error，但不能把 job 改成 failed。没有系统边界，这类语义很难写清楚。

## Resource：runtime 持有外部资源，而不是模块顶层偷拿

爬虫服务的外部资源很重：Prisma connection、RabbitMQ connection、BrowserPool、Hono server、worker subscriptions。过去脚本式代码最容易在模块顶层创建这些资源，导致 import 和运行绑定在一起。重构后 runtime 显式持有资源，并且 service shutdown 负责按顺序清理。

这次后期补了多轮资源清理测试：outbox publish 进行中不能先关闭 bus；service shutdown 要关闭 browser pool；worker cancellation 或 context cleanup 失败时，后续资源仍然要尝试关闭；RabbitMQ channel close 失败后仍要 close connection。这些都不是 ECS 名词本身带来的，它们来自对 Resource 边界的认真执行。

如果一个系统自己 new browser 或 new Prisma client，它会让测试和清理都失去统一入口。长期服务里，资源所有权比抽象层次更重要。

## Event 和 Schedule：把异步动作变成可恢复状态机

`EcsEvent` 同时作为 outbox。API 创建 job 时在数据库事务里写 job state 和 command event；事务提交后，outbox publisher 发布 RabbitMQ 消息；worker 消费后运行系统管线。这个设计把“创建任务”和“执行任务”解耦，也给 DB/MQ 之间的故障窗口提供恢复点。

Schedule 则表达系统顺序。它不追求游戏 ECS 那种高频并行调度，而是保证 workflow step 可控：前一步失败要记录 system run，job 取消后要停止，成功后要进入下一步。对于爬虫来说，这比“系统每帧跑得快”更重要。

一个好的 crawler schedule 应该能回答：这个 job 当前卡在哪个系统？上一个系统是否成功？失败错误是什么？是否还能重试？取消后是否还有系统继续跑？这些问题都和可运营性有关。

## 为什么没有强行造一个 World 类

原计划里保留了 `World` 概念，但最终没有为了名词完整去造一个空壳 `World`。原因是 `CrawlerRuntime`、store、bus、ports 和 scheduler 已经共同承担了世界职责：资源在 runtime，状态在 store，事件在 bus/outbox，行为在 systems，顺序在 scheduler。如果再加一个只做转发的 World，它不会减少复杂度，只会让真实边界更难看清。

这是这次很重要的架构经验：不要为了对齐某个模式而添加名义抽象。判断一个抽象是否必要，不看它是否补齐术语，而看它是否消除重复、收束依赖、表达不可替代的边界。这里的 World 是概念，不需要变成一个没有行为密度的类。

## Crawlee 的位置：保留为 adapter，不再定义运行时

这次没有否定 Crawlee。Crawlee/Playwright 仍然适合做浏览器执行、页面导航、响应监听和 DOM 交互。问题在于不能让 Crawlee `RequestQueue` 成为整个服务的全局任务队列，也不能让 Crawlee route 模块成为业务边界。

重构后，Crawlee 退回 adapter 位置：它可以执行旧 YouTube legacy crawler，也可以通过 Playwright-backed ports 为站点系统提供浏览器能力。但任务创建、状态持久化、重试、取消和产物查询都由 ECS runtime 管。这样工具仍然有用，但工具不再定义系统形态。

这对爬虫项目是一个可复用原则：浏览器框架应该封装页面动作，不应该拥有业务状态。业务状态一旦绑定框架，后续迁移、测试和恢复都会被框架生命周期牵着走。

## 这套 ECS 什么时候不值得用

这套设计不是银弹。如果只是一次性脚本，打开一个页面、抓几条数据、写一个文件，那么 ECS、outbox、component versioning 都会显得过重。如果没有跨进程恢复需求，也没有 API 查询任务状态的需求，直接函数调用可能更清晰。

但 Crawle 的场景满足几个条件：需要长期运行，需要登录态，需要人工扫码，需要浏览器资源管理，需要消息队列，需要持久化任务状态，需要迁移历史数据，需要多站点扩展。只有在这些复杂度真实存在时，crawler-domain ECS 才是合理的。

所以这次经验不是“以后所有爬虫都用 ECS”。更准确的结论是：当爬虫从脚本变成服务时，要先建模状态和失败模式；如果状态复杂到需要恢复、查询和审计，ECS 是一种合适的组织方式。

## 可复用的设计检查表

以后再做类似重构，我会先问这些问题：

- 哪些对象需要跨进程身份？它们是否应该成为 entity？
- 哪些状态需要版本化和 schema validation？它们是否应该成为 component？
- 哪些动作需要可记录、可取消、可重试？它们是否应该成为 system？
- 哪些外部资源必须由 runtime 统一持有和清理？
- 哪些事件需要 outbox，而不是直接 publish？
- 哪些浏览器能力应该通过窄 port 暴露，而不是泄漏完整 page？
- 哪些旧入口必须被 source-boundary test 防止回流？

如果这些问题都有具体答案，ECS 才不是口号。否则它只是把旧复杂度换了新名字。
