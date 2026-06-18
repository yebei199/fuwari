---
title: "大重构后期，真正重要的是补边界"
published: 2026-06-18
description: "Crawle ECS 重构后期几十个 fix 提交，为什么大多集中在 validation、terminal state 和资源清理。"
tags:
  - "防御式编程"
  - "Zod"
  - "稳定性"
category: 技术实践
draft: false
---

大重构前半段通常更有成就感：新 schema、新 API、新 worker、新 systems、新 migration CLI。它们让系统看起来真的变了。但后半段真正决定质量的，往往是大量小而具体的 hardening：validate artifact writes、validate entity writes、validate command envelopes、validate outbox options、validate route params、validate component writes、validate raw item writes。

这些提交不像“新功能”，却是长期服务能不能稳定运行的关键。主路径跑通只能说明设计方向可行；边界补齐才说明系统能承受错误输入、重复消息、取消请求和资源清理失败。

## 为什么后期会集中出现 validation

架构迁移前期需要先让新路径跑起来，所以很多边界会先按理想输入实现。等 API、store、outbox、worker、站点系统都接上后，系统入口变多了：HTTP params、request body、outbox options、message bus identifiers、component payloads、artifact data、raw item content、migration CLI arguments、worker subscription options。每个入口都可能被错误调用。

如果这些错误越过边界，就会在更深的地方制造脏状态。比如空 job id 进入 store，可能导致查询语义不明；artifact 缺 media type 却写入数据库，API 下载时才失败；raw item 写到非 job entity 上，job result listing 就无法解释；invalid routing key 传给 RabbitMQ，错误会变成 adapter 内部异常。

所以后期 validation 的目标是把错误挡在最近的边界，而不是让它们流到持久层或外部系统。

## Store 层：拒绝孤儿状态

ECS store 是最重要的边界。entity creation 要拒绝非法 kind 和空 label；component write 要拒绝空 entity id、空 component type、未知 entity 和不匹配的 entity kind；artifact/raw item writes 要拒绝缺失 job、非 job id、空数据、空 kind、空 media type；system run 要拒绝空 system/entity id 和空 error；event status update 要拒绝空 id、非法状态和空错误。

这些检查不是为了让错误消息更漂亮，而是为了防止孤儿状态。数据库里的孤儿状态会被后续 API、worker、migration 和分析脚本反复读到。比起事后清理，写入前拒绝便宜得多。

一个典型例子是 artifact/raw item job boundary。用户通过 `/jobs/:jobId/artifacts` 和 `/jobs/:jobId/raw-items` 查看产物。如果某个 artifact 不属于真实 job，或者 raw item 挂在非 job entity 上，API 就无法给出一致语义。store 层必须比调用方更严格。

## Component kind compatibility：payload 合法不代表归属合法

Zod schema 能验证 payload 形状，但不能自动验证它写到哪个 entity 上。一个合法的 `job_state` JSON，如果写到 `account` entity 上，仍然是错误数据。一个合法的 `session` component，如果写到 `raw_item` entity 上，也会破坏系统语义。

因此后期增加 known component type 与 entity kind 的兼容检查。这是很多 schema-driven 系统容易漏掉的一层：shape validation 只回答“它长得对不对”，domain validation 还要回答“它属于这里吗”。

这条经验可以推广到所有持久化系统。外部数据结构合法，不等于业务归属合法。尤其在 ECS 这种 entity/component 模型里，组件和实体的组合本身就是业务规则。

## API 层：错误请求不能创建 job

API validation 不应该止于“URL 能 parse”。YouTube channel task 必须接收 channel URL，而不是 video URL；comment task 必须接收 video URL，而不是 channel URL；off-site URL 即使语法正确也要拒绝。知乎 feed account id 要 trim，空字符串要拒绝。job route params、artifact id 和 raw item listing params 都要校验。

这些检查的共同原则是：非法请求不能创建 job，也不能写 outbox event。因为一旦错误 job 进入 outbox，worker 后续失败只是补救，而且会污染 job 列表、latest error 和 retry 统计。API 边界越早拒绝，系统后面越简单。

这次 `fix(api): check artifact parent jobs first` 也体现了类似原则。artifact 下载不应该只按 artifact id 找到数据，还要确认它属于请求的 job。否则 job-scoped API 会变成全局 artifact lookup，权限和归属语义都会变弱。

## Queue 层：消息标识也要 validation

message bus 输入也需要 validation。exchange、routing key、queue name、consumer id 这些字符串如果为空，不应该等 RabbitMQ 报错。fake bus 也应该执行同样规则，否则测试环境会比真实环境宽松。

outbox publisher options 也要验证。limit 和 maxAttempts 不能非法，否则 publisher 可能无限扫描、跳过重试或错误 dead-letter。runtime outbox scheduling interval 也要验证，否则服务可能以无意义的频率运行 publisher，甚至启动后立即进入异常循环。

这类 validation 常被低估，因为它不是业务字段。但基础设施参数一旦错了，影响范围比单个业务请求更大。

## Worker 层：terminal state 是状态转移边界

validation 不只检查输入格式，也检查状态转移是否合法。late cancel 曾经会把 completed job 改成 cancelled；stale delivery 曾经会让 completed/failed job 重放 pipeline；系统取消 job 后抛错曾经可能把 job 改成 failed。这些都不是字段格式问题，而是状态机边界问题。

修复后，terminal job cancellation 是 no-op 并返回持久状态；terminal job stale command 直接 ack；cancellation 在 pipeline 中途发生后阻止后续系统；取消后出现错误不覆盖取消状态。这些规则让 job status 不会被迟到消息或晚到错误随意改写。

从工程角度看，terminal state 应该被当成写保护边界。一旦 job 到达 completed、failed、cancelled 这类终态，任何后续事件都必须先证明自己有权修改它。默认动作应该是保守的。

## Resource cleanup：失败路径也要继续执行

重构后期还有一类 hardening 是资源清理。RabbitMQ channel close 失败时仍要 close connection；browser context cleanup 失败时仍要 close browser；service shutdown 中 worker cancellation 出错时仍要清理 server、browser pool、bus 和 database；outbox publish 进行中不能先关闭 bus。

这些不是“代码洁癖”。长期服务的资源泄漏通常发生在异常路径，而不是 happy path。测试如果只覆盖正常启动和正常关闭，很难发现这些问题。把 cleanup failure 写成测试，能迫使代码用 `finally`、错误收集和有序关闭表达真实资源所有权。

## 如何系统性做 boundary audit

这次后期的经验可以整理成一个 audit 方法：

1. 列出所有外部入口：HTTP body/params、env、CLI arguments、RabbitMQ messages、browser adapter results。
2. 列出所有持久化写入：entity、component、event、system run、artifact、raw item。
3. 列出所有状态转移：queued、running、completed、failed、cancelled、published、dead-lettered。
4. 列出所有资源生命周期：server、bus、browser pool、worker subscription、Prisma client。
5. 对每一项写一个“错误输入或失败路径应该怎样”的测试。

这个过程会产生很多小提交，但它们都很有价值。每个提交只修一个边界，review 清楚，回滚清楚，验证也清楚。

## 这次 hardening 的结论

大重构不是主路径跑通就结束。主路径跑通只是中场。真正让系统从“能演示”变成“可维护”的，是后期 validation、terminal state、resource cleanup 和 source-boundary 的持续补齐。

如果下次再做类似工作，我会在功能迁移完成后明确安排一轮 hardening phase，而不是把它当成零散收尾。它应该是计划的一部分，因为持久化服务最怕的不是请求失败，而是失败后留下不可解释的状态。
