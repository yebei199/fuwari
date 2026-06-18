---
title: "爬虫从脚本变成服务，真正改变的是什么"
published: 2026-06-18
description: "从 Crawle 的 ECS 重构总结，一次性脚本和长期爬虫服务在入口、副作用、状态和运维边界上的本质差异。"
tags:
  - "爬虫架构"
  - "服务化"
  - "工程复盘"
category: 技术实践
draft: false
---

很多爬虫项目一开始都是脚本。给一个 URL，打开浏览器，解析页面，写入数据库，结束进程。这个阶段最重要的是把目标数据拿回来，代码结构只要能承载当前路径就够了。Crawle 早期也有这种痕迹：Crawlee starter 入口还在，站点逻辑和运行入口距离很近，浏览器执行、数据库写入和任务状态更像一个同步流程里的几个步骤。

这次 20 小时重构最大的变化，不是把脚本换成了几个 class，也不是把数据库表改名，而是把 Crawle 的运行身份从“一次运行的程序”改成了“可以长期运行、接受命令、恢复状态、解释失败的服务”。这个改变会影响每个边界：模块 import 时不能启动爬虫，API 创建任务不能直接执行重活，数据库写入不能和消息发布互相假设成功，浏览器资源不能靠进程退出自然释放，失败不能只靠日志说明。

## 脚本可以靠顺序，服务必须靠协议

脚本的世界里，顺序就是协议。代码从上往下执行，失败就抛异常，进程退出后资源大概率会被系统回收。即使中间状态不完整，也常常可以靠人工重新跑一次。长期服务的世界完全不同。API 请求、outbox publisher、RabbitMQ consumer、worker pipeline、浏览器上下文和数据库事务都在不同时间点发生，任何一步都可能和其他步骤交错。

因此服务化之后，协议必须显式化。创建 job 的协议是：校验输入，写 job entity，写 job_state component，写 command outbox event，并且这些写入必须在同一个事务里完成。发布消息的协议是：pending event 被投递到 RabbitMQ，等待 broker confirm，成功后标记 published，失败记录 attempts。worker 的协议是：验证 command envelope，检查 job 状态，运行系统，按错误类型决定 ack、retry 或 failed。

这些协议看起来啰嗦，但它们替代了脚本时代的隐含顺序。隐含顺序只能在单进程、单次运行里成立；显式协议才能跨 API、DB、MQ、worker 和重启边界成立。

## import-time side effect 是脚本遗留里最危险的一类

脚本写法最容易留下 import-time side effect。一个文件顶层创建 Prisma client，一个模块顶层启动 Crawlee crawler，一个 helper 顶层读取 cookie 并准备请求头。单独运行时看起来方便，但当项目开始有测试、worker、API server 和 CLI 入口之后，这类副作用会让系统无法预测。

这次重构早期必须先把 `src/main.ts` 改成明确的 service bootstrap，并让站点模块只导出函数、系统或 adapter。导入模块不等于连接数据库，导入站点不等于打开浏览器，导入 worker 不等于消费 RabbitMQ。只有启动函数被显式调用，真实资源才会被创建。

这个边界直接影响测试质量。如果 import 一个 parser 会顺手启动浏览器，单元测试就不再是单元测试；如果 import 一个 API route 会创建数据库连接，测试进程就很难隔离；如果 import 一个 site module 会加载真实 session material，安全风险和环境耦合都会增加。服务化的第一步不是抽象业务，而是让 import 重新变成纯粹的代码加载动作。

## API 不应该直接替代 worker

脚本项目迁服务时常见误区是：给旧函数包一层 HTTP route。用户请求来了，route 里直接打开浏览器、抓页面、写数据，然后返回结果。这个方式改动小，但它把 HTTP 生命周期和爬虫生命周期绑死了。浏览器任务慢、失败多、需要重试，还可能需要人工扫码；HTTP route 不适合承载这些动作。

Crawle 的新路径让 Hono API 只负责创建任务、查询任务、取消任务和读取 artifacts。真正执行由 RabbitMQ command worker 完成。API 返回的是 job id 和状态，worker 负责运行站点系统，状态通过 ECS component 和 system run 落库。

这个拆分的收益是显性的。API 可以快速失败和快速返回，worker 可以独立扩缩容，任务可以被重试，取消可以落成持久状态，登录二维码可以作为 artifact 暴露给调用方。更重要的是，HTTP 请求断开不再决定爬虫任务是否存在。

## 状态真相源必须从进程内存移到数据库

脚本可以把很多状态放在内存里。当前抓到第几页、当前 cookie 是什么、已经解析了哪些 item、最后一次错误是什么，都可以随着进程结束一起消失。长期服务不能这么做。worker 可能重启，API 需要查询，用户可能取消，outbox publisher 可能晚于 job 创建恢复，重复消息可能再次到达。

这次 ECS schema 的意义就在于把状态真相源放进 Postgres。job、session、response capture、raw item、artifact、system run 都有可以查询的持久表达。内存里可以有缓存和执行上下文，但不能成为唯一事实来源。

这个原则会改变很多实现细节。比如二维码登录不再打开本地图片查看器，因为那只是当前进程的交互动作；它应该生成 artifact，让 API 能查询。feed 响应监听不应该只存在 Playwright callback 里；它应该把捕获结果交给系统，再以组件或 raw item 写入。去重不应该靠当前进程的 Set；它应该靠 content hash 和数据库唯一性。

## 浏览器是昂贵资源，不是普通函数依赖

服务化爬虫里，浏览器资源的生命周期必须被认真设计。脚本时代常见写法是函数里 launch browser，最后 close，失败时靠 finally。长期服务里，任务可能排队，worker 可能并发，系统可能取消，关闭时可能还有 outbox publish 或 browser task 在进行。浏览器不能散落在任意函数里创建。

这次通过 browser port 和 adapter 把站点逻辑同 Playwright/Crawlee 的具体对象隔开。站点系统依赖的是“能登录、能导航、能捕获响应、能提取数据”的窄接口，而不是到处传 `Page`。这样测试可以注入 fake port，真实 worker 可以使用 Playwright adapter，资源清理可以集中控制。

这不是为了追求抽象漂亮，而是为了避免资源所有权不清。谁创建 browser，谁关闭 browser，取消任务时谁停止后续系统，shutdown 时谁等待活跃任务，这些问题都必须在服务化之后回答。

## 日志不等于可观测状态

脚本失败时，日志常常够用。因为运行的人就在终端前，失败发生时上下文还在。服务失败时，日志只是证据之一。用户查询 job 时，需要看到状态、attempts、latest error、artifacts、raw item 数量和 system run。运维排查时，需要知道消息是否发布、worker 是否 ack、系统运行到哪一步。

这次引入 `EcsSystemRun`、outbox event status、job_state component 和 artifact/raw item 查询，就是把“日志里可能有”改成“状态里一定能查”。日志适合补充时间线和堆栈，数据库状态适合表达系统当前事实。两者职责不同。

一个很实际的判断是：如果用户不看服务日志，就完全不知道任务为什么失败，那状态模型还不够成熟。长期服务必须能通过 API 暴露最基本的失败解释。

## 取消和重试是服务语义，不是异常处理技巧

脚本里取消任务通常等同于杀进程。服务里取消是一个持久语义：用户发出取消请求，job 状态变成 cancelled，worker 即使已经消费到 command，也必须在系统边界检查并停止后续动作。取消不是异常的一种，因为它不是系统失败，而是用户意图。

重试也一样。不是所有错误都该重试。浏览器临时超时可能重试，RabbitMQ publish 暂时失败可以重试，站点 DOM 变化导致 parser 找不到字段可能需要失败并暴露错误，job 输入本身错误则应该 non-retryable。把所有错误塞进一个 catch 再统一 retry，会让系统看起来努力，实际上是在制造重复失败。

这次 worker 状态机的很多 hardening 都围绕这个点展开：terminal job 的 stale delivery 要 ack，cancelled job 不能继续 pipeline，系统取消后抛错不能覆盖取消状态，non-retryable job data error 应该 failed 并 ack。

## 服务化之后，文档也是运行边界的一部分

脚本项目的文档可以写“运行这个命令”。服务项目需要说明默认门禁、opt-in smoke、需要的外部依赖、哪些测试需要真实 Postgres/RabbitMQ、哪些 live 测试需要人工扫码、哪些旧路径已经删除。否则下一次维护者会把所有验证都混在一起，要么跑不起来，要么误以为一次 smoke 通过就代表长期可靠。

这次补 `README.md`、change log、`just` task 和 blog 复盘，不只是为了好看。它们把运行约束写下来：默认 API 绑定本地，RabbitMQ worker 用 AMQP endpoint，不再把 Crawlee `RequestQueue` 当全局任务队列，真实账号 Zhihu live smoke 可以被豁免，长期可靠性不能由一次测试证明。

服务化越彻底，越需要把这些边界写成可读材料。因为边界一旦只存在于作者脑子里，下一次修改就会回到脚本式捷径。

## 我会用的迁移判断标准

如果下次再把爬虫脚本迁成长服务，我会用下面的问题判断是否真的完成：

- import 任意业务模块，会不会创建真实外部资源？
- HTTP route 是否只创建和查询任务，而不是直接执行长时间爬取？
- 任务状态是否能在进程重启后继续查询和恢复？
- 数据库写入和消息发布之间是否有 outbox 或等价恢复机制？
- worker 对 malformed、missing、cancelled、terminal、retryable、non-retryable 是否有不同语义？
- 浏览器资源是否有明确所有者和关闭路径？
- 登录二维码、抓取结果和失败信息是否能通过 API 或持久 artifact 查询？
- 默认测试、opt-in smoke 和长期运维验证是否分层？

这些问题比“代码是否更整洁”更能判断脚本到服务的迁移质量。服务化不是把函数放到服务器上，而是把执行、状态、失败和资源都改成可恢复的协议。
