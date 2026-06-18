---
title: "大重构里，TDD 更像验收协议"
published: 2026-06-18
description: "从 Crawle ECS 重构看，如何用失败测试、边界测试和 opt-in smoke 把架构迁移压到可验收范围内。"
tags:
  - "TDD"
  - "测试策略"
  - "重构"
category: 技术实践
draft: false
---

这次 Crawle 重构里，TDD 的意义不是“先写一个小测试再写一个小函数”。面对 171 个提交级别的架构迁移，TDD 更像验收协议：先把系统应该遵守的边界写成测试，再让生产代码逐步满足这些边界。测试不是实现之后的确认动作，而是重构计划本身的一部分。

这个区别很重要。普通功能开发可以围绕输入输出设计测试；大重构要验证的不只是输出，还包括旧路径有没有消失、错误输入会不会越过边界、两个 store 实现是否语义一致、worker 在重复投递和取消时是否会破坏状态、默认门禁和真实 smoke 是否分层清楚。

## 大重构的测试对象不是一个函数，而是一组承诺

这次最早的一批测试覆盖 ECS component schema、API job 创建和取消、outbox idempotency、retry 行为、知乎 parser/session validation、legacy migration dry-run/apply。它们不是随机挑模块测，而是在定义“新系统应该是什么样”。

例如，API 创建 job 不应该只是返回 200。它应该创建 job entity，写 job_state component，写 command outbox event，并且在输入非法时不留下半截状态。outbox 也不只是“调用 publish 一次”，而是 pending event 只发布一次，失败要记录 attempts，耗尽重试后进入 dead-letter 语义。知乎 parser 也不只是能 parse 一条示例，它要跳过广告、提取 HTML text、生成稳定 content hash。

这些测试共同定义了新架构的最小验收面。没有它们，重构很容易变成“新代码看起来像新架构”，但状态仍然可以从旧路径漏出去。

## Source-boundary tests 是架构迁移的防回流装置

这次最有价值的一类测试不是传统业务测试，而是 source-boundary tests。它们检查旧 YouTube route path 不再被测试依赖，旧 DB helper 不再存在，源码不包含硬编码 cookie/session material，旧 side-effect crawler startup 不能回流，文件长度边界不能被突破。

这类测试的作用是防止“临时方便”把旧结构带回来。大重构后期经常会遇到这种诱惑：为了快速修一个测试，从旧 route re-export import 一下；为了兼容旧脚本，恢复一个 DB singleton；为了调试登录，把 cookie 临时写进源码。每次看起来都合理，但累积起来会让新架构失去边界。

source-boundary test 的价值在于把“不要再这么做”变成可执行规则。它不是替代 code review，而是让 code review 不必每次都靠人记忆同一条禁令。

## Store contract tests 防止测试环境和真实环境分叉

这次同时有 in-memory ECS store 和 Prisma-backed ECS store。前者让单元测试更快，后者是真实服务边界。只要两者语义不一致，测试就会制造假安全感。重构中确实出现过这类问题：内存 store 的 job listing 顺序和 Prisma store 不一致，Prisma `getJob` 曾经可能把非 job entity 当成 job，artifact/raw item 写入在两个实现里的边界检查也需要对齐。

因此 store contract tests 要验证的不只是“某个实现能用”，而是两个实现面对同一类输入时有同样语义。job 读取要拒绝空 id，latest component 读取要拒绝空 entity/component type，component write 要检查 entity 存在和 component-kind compatibility，artifact/raw item 只能归属真实 job。

这一类测试的经验是：只要有 fake 或 in-memory 实现，就必须把它当成 contract participant，而不是随便写一个测试替身。否则真实 store 和 fake store 会慢慢演化出两套规则。

## Worker 状态机要用失败测试写出来

command worker 的主路径很简单：收到命令，找到 job，运行系统，ack。真正复杂的是失败路径。重构过程中，测试先后暴露了多种问题：已取消 job 仍然执行系统；pipeline 中前一个系统取消 job 后，后一个系统仍然运行；系统取消 job 后又抛错，worker 把 job 改成 failed 或 retry；completed/failed job 收到 stale delivery 后重放系统；missing job 的 command 仍然进入 pipeline。

这些测试迫使 worker 形成明确规则：malformed envelope 和 unsupported command 不进入系统；missing job 先拒绝；terminal job 的 stale delivery 直接 ack；pipeline 每个系统运行前重新检查 cancellation；取消状态优先于后续错误；retryable system error 保留 job queued 并增加 attempts；non-retryable job data error 标记 failed 后 ack。

这类状态机不能只靠代码直觉。没有失败测试，通用 catch block 很容易把所有错误都映射成 retry 或 failed，最终覆盖用户取消意图，或者让 terminal job 被重复执行。

## API contract tests 要在写入前拦截错误

API 是外部输入边界。重构后补了很多 API contract：知乎 feed account id 要 trim，空 account id 要拒绝；YouTube channel task 不能接受 video URL，comment task 不能接受 channel URL，off-site URL 即使语法正确也要拒绝；job route params、artifact path params、raw item listing path params 都要校验。

这类测试的核心原则是：错误 job 不应该进入数据库，更不应该进入 outbox。如果 API 接受了错误输入，worker 再失败只是后置补救；如果 API 在写入前拒绝，系统就不会产生需要清理的持久状态。

这也改变了测试断言重点。不是只断言响应码，而是断言非法请求不会创建 job、不会写 outbox event、不会留下 orphan artifact/raw item。对持久化系统来说，“没有写入”常常比“返回错误”更重要。

## Opt-in smoke 不是低级测试，而是不同层级测试

默认 `bun run verify` 不能依赖真实 Postgres/RabbitMQ、真实浏览器、外部网站和人工扫码。否则门禁会不稳定，最终被开发者绕过。于是这次把 service smoke 和 YouTube worker smoke 做成 opt-in：需要显式环境变量和 disposable infrastructure，必要时通过 `just test-service-smoke` 或 `just test-youtube-worker-smoke` 执行。

service smoke 验证 API 创建 job、Prisma 写 ECS/outbox、RabbitMQ publish 和 event status 更新。YouTube worker smoke 更进一步，验证真实浏览器 worker、RabbitMQ command、Postgres raw-item persistence 和当前 public YouTube channel 页面。知乎 QR/feed live smoke 因为需要真实账号和人工扫码，被明确豁免。

这不是降低测试标准，而是把验证放在正确层级。默认门禁验证可重复 contract；opt-in smoke 验证真实链路能跑通一次；长期可靠性需要 soak test、监控、告警和故障注入。把三者混在一个命令里，只会让测试既慢又脆。

## 测试如何跟随重构阶段变化

这次测试不是一次写完的。随着迁移推进，测试的关注点也在变化。早期测试证明 ECS kernel、schema、API、outbox、Zhihu systems 可以跑。中期测试开始保护 YouTube site layer、legacy raw store、browser ports 和 worker starter。后期测试集中在 validation hardening、terminal state、resource cleanup、RabbitMQ confirm/prefetch、migration CLI redaction 和 duplicate identity。

这个节奏很有参考价值。大重构早期不要试图一次覆盖所有边界，否则会被未知设计拖慢；但每完成一个阶段，就要把该阶段的边界固化成测试。后期则要专门做 boundary audit，把所有入口、写入、状态转移和资源清理逐个补失败测试。

## 下次我会复用的测试分类

如果再做类似重构，我会提前列出以下测试分类：

- schema tests：组件、命令、配置、迁移输入输出的结构验证。
- store contract tests：fake/in-memory store 和真实 store 的语义一致性。
- state-machine tests：job cancellation、terminal job、retry、DLQ、non-retryable error。
- API boundary tests：非法输入不写入持久状态，不发 outbox。
- source-boundary tests：旧路径、硬编码 secret、import-time side effect 不回流。
- adapter tests：RabbitMQ confirm/prefetch/close，browser port extraction，resource cleanup。
- opt-in smoke tests：真实 DB/MQ/browser 链路，但不进默认门禁。

这套分类比“补点测试”更可靠，因为它直接映射重构风险。

## 这次 TDD 的真正结论

这次最终 `bun run verify` 和 `bun run audit` 通过，说明默认可重复契约已经落地。但更重要的不是最后一次通过，而是测试在过程中不断暴露设计缺口：取消语义、terminal delivery、DB/MQ 确认、store 边界、URL task shape、legacy import 回流、migration redaction。每暴露一个缺口，重构边界就更清楚一点。

大重构里的 TDD 不是追求形式上的红绿循环，而是把“完成”的定义写成可执行证据。只要目标是迁移架构，测试就必须覆盖架构边界；只要目标是长期服务，测试就必须覆盖失败路径；只要目标是清理 legacy，测试就必须防止 legacy 回流。
