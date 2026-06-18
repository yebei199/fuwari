---
title: "队列可靠性不只是在失败时重试"
published: 2026-06-18
description: "从 Crawle 的 Postgres outbox、RabbitMQ 和 command worker 修复中总结异步爬虫的可靠性边界。"
tags:
  - "RabbitMQ"
  - "Outbox"
  - "异步系统"
category: 技术实践
draft: false
---

异步爬虫里，“失败就重试”是一句太粗糙的话。真正需要设计的是：什么时候消息算发布成功，什么时候 worker 可以 ack，什么时候应该 retry，什么时候应该 reject，什么时候应该把 job 标成 failed，什么时候应该保留 queued，什么时候取消状态应该赢过错误。这些语义如果不写清楚，系统会在真实失败里悄悄损坏状态。

这次 Crawle 重构把这些问题拆成了四层：Postgres outbox、RabbitMQ adapter、command worker state machine、runtime resource cleanup。每一层都曾经暴露过具体缺陷，也都通过测试补成了可验证合同。

## Outbox 解决的是 DB 和 MQ 之间的裂缝

API 创建 job 时，如果直接写数据库再 publish RabbitMQ，中间任何进程崩溃都会留下“数据库里有 job，但消息没发出去”的状态。如果先 publish 再写数据库，worker 可能消费到一个数据库里还不存在的 job。outbox pattern 的价值就在这里：把 command event 作为数据库事务的一部分写入，事务提交后再由 outbox publisher 发布。

这次 job 创建最终需要在同一个事务里完成三件事：创建 job entity，写 job_state component，写 command outbox event。只有这三者一起成功，系统才认为任务创建成功。后续 publisher 扫描 pending events，发布 RabbitMQ，成功后标记 event published，失败则记录 attempts 和 error，耗尽重试后进入 dead-letter 语义。

这个设计不会让系统“不会失败”。它让失败后有恢复点。DB commit 后 publish 前崩溃，event 仍然 pending；RabbitMQ 暂时不可用，event 不会被误标记为 published；publisher 重启后仍然能继续处理。这就是长期服务需要的可靠性，而不是脚本式“这次跑通就行”。

## RabbitMQ publish 不能只看函数有没有抛错

RabbitMQ adapter 后期修了几个非常具体的问题。第一个是 `channel.publish()` 返回 `false`。这个返回值代表写入未被立即接受，可能是 backpressure。如果代码把它当成功，outbox 就会把实际未确认的事件标记为 published。

第二个是普通 channel 和 confirm channel 的差异。普通 publish 调用返回后，并不等价于 broker 已确认消息。对 outbox 来说，必须等 broker confirm，否则数据库状态会提前宣称消息已投递。修复后 adapter 优先使用 confirm channel，并等待 `waitForConfirms()`；未接受或未确认的 publish 都会返回错误，让 outbox retry path 继续可见。

第三个是 consumer prefetch。浏览器 worker 执行任务很重，不应该一次预取一批 command。`prefetch(1)` 是保守选择：每个 worker 一次只持有一个任务，避免任务被某个慢 worker 预取后长时间不可见。这牺牲吞吐峰值，但更符合浏览器爬虫的资源模型。

第四个是 close path。channel close 失败时，connection 仍然要尝试关闭。长期服务里，关闭路径不是附属品；资源泄漏通常就发生在错误路径。

## Worker 的核心不是执行系统，而是保护状态机

command worker 看起来只是把 command 映射到 system pipeline，但真实复杂度在状态机。它要验证 command envelope，要查 job 是否存在，要检查 job 是否 terminal，要在每个系统前检查 cancellation，要区分 retryable 和 non-retryable error，还要决定 ack/retry/reject。

这次引入 `NonRetryableCommandError` 是一个关键边界。比如 YouTube job 的 site/task 不匹配，或缺少必需 URL，这不是临时失败，重试没有意义。正确动作是标记 job failed 并 ack。相反，浏览器临时失败或系统 recoverable error，则应该记录 system run，保留 job queued，增加 attempts，并让 RabbitMQ 重投。

missing job 也不能重试。一个 command 引用不存在的 job，如果继续进入 pipeline，只会制造更多错误。worker 应该在系统运行前拒绝或确认这类消息。terminal job 的 stale delivery 也一样：completed 或 failed job 收到旧 command，正确动作是 ack，不是为了“保险”重跑系统。

## 取消语义要独立于错误语义

取消是用户意图，不是普通异常。这次测试先暴露了几个取消相关 bug：job 已取消仍然执行系统；pipeline 中前一个系统取消 job 后，后一个系统继续运行；系统取消 job 后又抛错，worker 把 job 写成 failed 或 retry。修复后规则更明确：每个系统运行前重新检查 job 状态；如果 job 在 pipeline 中途变成 cancelled，后续系统停止；如果取消后出现系统错误，取消状态保留。

这个规则值得单独强调。很多状态机 bug 都来自把 cancellation 当成 error 的一种。实际上 cancellation 表达的是“不要继续做了”，error 表达的是“做的过程中失败了”。两者在 UI、重试和最终状态上语义不同，不能混成一个 catch block。

## System run 是诊断的最小单位

worker 失败后，用户只看到 job failed 是不够的。系统需要记录哪个 system 运行了、哪个 system 失败了、错误是什么、job 当时是什么状态。`EcsSystemRun` 的价值在这里：它让 pipeline 不再是黑盒。

这对爬虫尤其重要。失败可能来自登录 session 失效、页面 DOM 变化、网络超时、parser 不兼容、DB 写入失败或用户取消。没有 system run，只能翻日志；有了 system run，API job detail 可以暴露 attempts、timestamps、latest error 和状态元数据，用户至少知道失败发生在哪个阶段。

## Runtime cleanup 也是可靠性的一部分

很多队列可靠性讨论只谈 publish 和 retry，但长期服务还必须能正确关闭。Crawle 后期补了 service shutdown 的 single-flight outbox scheduling：如果 outbox publish 正在进行，关闭时先等待 active publish，再关闭 bus。否则可能出现 publish 正在写 RabbitMQ，bus 先被 close 的竞态。

worker starter 也补了 cleanup 语义：browser context cleanup 失败时仍然关闭 browser；worker cancellation 失败时继续清理后续资源；service cleanup 记录第一个错误，但不因为前一个资源失败就跳过后面资源。真实服务不是测试进程，资源泄漏会在长期运行中慢慢放大。

## 这套设计仍然不能证明长期可靠

service smoke 和 YouTube worker smoke 已经能在临时 Postgres/RabbitMQ 和真实浏览器路径上跑通一次，但这不能证明长期可靠。它只能证明链路在某个时刻能走通。长期可靠还需要持续运行、指标、日志、告警、重启演练和故障注入。

这不是测试不足，而是验证层级不同。单元和集成测试证明状态机契约；adapter tests 证明 RabbitMQ 行为封装；opt-in smoke 证明真实链路可执行；soak/ops 才证明长期稳定性。把这些混在一起，会导致默认门禁又慢又脆，最终失去价值。

## 可复用的可靠性检查表

以后设计类似异步爬虫 worker，我会逐项检查：

- 创建 job 和创建 command event 是否在同一事务里？
- publish 是否等待 broker confirm，而不是只看函数返回？
- publish backpressure 是否会阻止 outbox 标记 published？
- consumer 是否按 worker 能力设置 prefetch？
- malformed command 是否会进入 pipeline？
- missing job 是否会被无意义 retry？
- terminal job 的 stale delivery 是否直接 ack？
- cancellation 是否会阻止后续系统运行？
- retryable 和 non-retryable error 是否有不同状态语义？
- shutdown 是否等待正在进行的 publish，并继续清理后续资源？

这张表比“失败就重试”更接近真实可靠性。异步系统的可靠不是一个点，而是一串边界都不能掉链子。
