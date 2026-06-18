---
title: "数据迁移不是把旧表搬到新表"
published: 2026-06-18
description: "Crawle ECS 重构中的 Prisma schema、legacy migration、raw item identity 和数据边界经验。"
tags:
  - "Prisma"
  - "数据迁移"
  - "ECS"
category: 技术实践
draft: false
---

这次 Crawle 的数据层重构不是“把旧表字段搬到新表”。如果只是换表名，旧问题会继续存在：状态仍然分散，旧 helper 仍然能绕过新边界，历史数据和新数据使用不同 identity，迁移脚本可能泄露 session，错误写入可能留下孤儿状态。真正的迁移，是把旧数据放进新系统的语义里。

新的 Prisma schema 围绕 ECS runtime 设计：`EcsEntity` 保存身份，`EcsComponent` 保存 versioned 状态，`EcsEvent` 作为 outbox，`EcsSystemRun` 保存系统执行记录，`EcsArtifact` 保存 QR 等产物，`EcsRawItem` 保存高查询价值的抓取结果。这组表不是站点专用表，而是服务运行时的事实来源。

## 先区分状态、事件、产物和历史输入

旧系统里容易混在一起的几类数据，在新设计里被拆开。job 当前状态是 component，command 是 event/outbox，二维码截图是 artifact，抓取结果是 raw item，历史 `original_crawl_data` 和 `youtube_video` 是迁移输入。这个拆分让每类数据都有明确生命周期。

例如登录 session 不应该被当成普通 raw item，它是 account/session entity 下的状态组件。feed 响应不是最终结果，它可以作为 response capture component 连接 capture system 和 parser system。抓取出的知乎推荐、YouTube channel video、YouTube comment 才是 raw item，它们需要 content hash 去重和 job 归属。

这个区分是迁移脚本能否写正确的前提。如果不先定义语义，脚本只能做字段搬运，最后得到一批名字很新的旧数据。

## Raw item identity 是迁移的核心

抓取结果必须去重。去重不能依赖自增 id，也不能依赖迁移时的临时顺序。每类 raw item 都需要稳定 identity。知乎 feed item 可以基于内容边界和 item id 生成 hash；YouTube channel video 需要 channel URL 和 video URL 共同组成 identity；YouTube comment 也要围绕视频、评论内容和来源定义稳定边界。

后期补 `feat(migration): map legacy youtube videos`，就是因为历史 `youtube_video` rows 不能被遗忘在旧表语义里。它们要映射成 `youtube_channel_video` raw items，并使用和现行 YouTube systems 一样的 channel/video hash identity。否则迁移数据和新抓取数据会形成两套去重规则。

这个经验很重要：迁移历史数据时，不要只问“旧字段对应新字段是什么”，还要问“新系统如何判断它是不是同一个东西”。identity 对齐比字段对齐更关键。

## Migration CLI 必须默认安全

迁移脚本经常被当成一次性工具，所以容易写得粗糙。但一旦它要处理真实数据，它就是生产工具。Crawle 的 legacy migration CLI 最终需要 dry-run、apply、duplicate guard、redacted summary 和显式 `--apply`。默认只预览，不直接写入。

dry-run 的价值是让维护者看到会迁移多少行、会生成哪些 raw item identity、是否存在重复、是否有无法映射的记录。apply 的价值是把已经验证的计划写入 ECS store。redaction 的价值是避免 CLI 输出泄露 cookie/session material。duplicate guard 的价值是防止迁移前就把冲突写进数据库。

这些设计都来自一个原则：迁移脚本的失败应该发生在写入之前。迁移后再清理坏数据，成本远高于迁移前拒绝错误计划。

## 临时 legacy delegate 可以存在，但必须退出

Prisma schema 改成 ECS 后，旧 legacy 文件引用被删除的 model，typecheck 会失败。早期用一个窄 legacy delegate shim 过渡是合理的，它让迁移可以分阶段推进。但如果这个 shim 长期存在，就会成为旧真相源的复活点。

这次后续把旧写入路径迁到 ECS raw-item/component delegates，删除 `src/utils/db/pg_db.ts`，并用 source-boundary test 防止它回来。这个过程说明临时兼容不是罪，忘记移除才是风险。

判断临时 DB shim 是否应该保留，可以看三个条件：是否还有无法迁移的真实调用方，是否会在模块 import 时创建全局 Prisma client，是否允许新写入绕过 ECS store。只要后两者为真，就应该尽快移除。

## Store 写入前必须验证边界

数据层 hardening 后期补了很多看似琐碎的验证：entity kind 和 label 不能非法；component write 必须检查 entity 存在和 component-kind compatibility；artifact/raw item 必须属于真实 job；event status 更新必须拒绝空 id、非法状态和空错误；system run 不能缺 entity/system id；job creation 要在写入前验证 site/task 输入。

这些验证的共同目标是防止持久化孤儿状态。孤儿状态是数据库系统里最难处理的债，因为它不会只影响当前请求，还会被 API listing、worker retry、migration apply 和后续分析反复读到。入口拒绝错误，比事后修数据便宜得多。

特别是 artifact/raw item 的 job boundary。一个 artifact 如果不属于真实 job，用户之后如何通过 API 找到它？一个 raw item 如果写到非 job entity，job result listing 如何解释它？这些问题不能靠约定解决，必须在 store 层拒绝。

## In-memory store 和 Prisma store 要共享语义

测试里的 in-memory store 不能只是“能让测试跑”的替身。它必须和 Prisma store 共享业务语义。否则开发时以为通过，真实数据库路径却表现不同。

这次对齐了多个细节：job list 返回 newest-first，`getJob` 只返回 job-kind entity，artifact/raw item listing 按 job boundary 查询，component writes 检查 entity-bound，known component type 检查 entity kind。每次对齐都让测试环境更接近真实运行环境。

这给出的经验是：如果 fake store 比真实 store 宽松，它会掩盖 bug；如果 fake store 比真实 store 严格但规则不同，它会制造假失败。最好的方式是把输入验证和 contract 尽量抽到共享层，两边调用同一套 parser/guard。

## 历史表只能作为输入，不应该继续作为运行时写入目标

重构后，历史 SQL、fixtures 和 migration source 可以继续提旧表，因为它们是迁移输入。但新抓取输出不应该再写 legacy table。知乎 feed、保存 session、YouTube channel videos、YouTube comments 都应该通过 ECS store 写入。旧表继续作为写入目标，会让系统永远有两套真相源。

这条边界也影响未来开发。如果后续还要迁移其它站点，应该先定义 ECS raw item type 和 identity，再写 migration dry-run，再加 duplicate/redaction guard，最后才允许 apply。不要为了“先跑起来”新建一个站点专用临时表，否则下一次重构会重复今天的问题。

## 这次数据层重构的结论

数据迁移不是搬家，而是语义归并。表结构只是结果，真正重要的是：状态、事件、产物和历史输入是否分开；raw item identity 是否稳定；迁移 CLI 是否默认安全；legacy helper 是否有退出机制；store 是否拒绝坏边界；测试替身是否和真实 store 共享 contract。

如果这些问题没有解决，新表只是旧债的新名字。解决之后，Postgres 才不只是存储层，而是长期 crawler runtime 的可恢复事实来源。
