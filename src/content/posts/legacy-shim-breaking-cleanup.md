---
title: "删除兼容 shim 为什么是 breaking change"
published: 2026-06-18
description: "用 YouTube legacy route 清理说明，兼容层什么时候保护用户，什么时候保护技术债。"
tags:
  - "兼容性"
  - "技术债"
  - "重构"
category: 技术实践
draft: false
---

这次重构里，YouTube legacy route shim 的处理看起来只是删三个小文件，实际代表一个重要取舍：什么时候为了兼容保留旧入口，什么时候必须承认这是 breaking cleanup。

当时还存在三个旧路径：`src/routes/youtube/chanel.ts`、`src/routes/youtube/comment.ts`、`src/routes/youtube/raw_item_store.ts`。它们已经不是主要实现，只是从旧路径 re-export 到 `src/sites/youtube/...`。也就是说，新架构已经把 YouTube 逻辑迁到 site layer，但老代码如果还写旧 import path，仍然能跑。

## Shim 的价值：给迁移争取时间

兼容 shim 本身不是坏东西。大重构中，直接删除所有旧路径往往会让外部脚本、未迁移分支、用户本地代码和测试同时失败。保留一个薄 shim，可以让调用方有时间从旧路径迁到新路径，也可以让重构先完成内部结构迁移，再处理外部兼容。

这次早期保留 shim 是合理的，因为 YouTube 迁移不是一步完成：先把 item types 移到 site layer，再把 raw store 移到 `src/sites/youtube/legacy_raw_store.ts`，再把 Crawlee adapter 移到 `legacy_channel_crawler.ts` 和 `legacy_comment_crawler.ts`，再把 API/worker 路径接上。如果在这些步骤没完成前就删除旧路径，会把迁移和兼容问题混在一起。

兼容层的正确使用方式是：明确它是临时过渡，内部新代码不再依赖它，测试逐步迁走，文档说明新入口在哪里，最终选择一个 breaking cleanup commit 删除它。

## Shim 的风险：旧边界会继续被保护

兼容 shim 最大的问题是它看起来太无害。一个一行 re-export 很容易被忽略，但它实际上保留了一个旧 API。只要旧路径还存在，就会有人继续 import；只要测试还通过旧路径覆盖行为，测试就会保护旧边界；只要文档还提旧入口，新维护者就会误以为 route layer 仍然是合法入口。

这次重构目标非常明确：YouTube 执行要进入 ECS API/worker 或显式 site-layer legacy adapter，`src/routes/youtube/*` 不再作为爬虫入口。如果 shim 长期保留，就会削弱这个边界。项目表面上迁到 `src/sites/youtube`，实际依然默认支持旧 route import path。

这就是技术债最常见的形态：不是一段大而丑的代码，而是一条“暂时保留”的旧路径，没有截止时间，没有 source-boundary test，也没有迁移说明。

## 为什么删除 shim 是 breaking change

breaking change 不等于当前主线代码会坏。它的意思是已有调用方契约被破坏。模块路径就是契约的一部分，尤其在 TypeScript/Node 项目里，很多内部模块没有显式 public API，实际被引用的路径就是事实 API。

如果某个外部脚本写过：

```ts
import { collectComments } from "./src/routes/youtube/comment.js";
```

删除 `src/routes/youtube/comment.ts` 后，这段代码会直接 import fail。即使 `collectComments` 的实现仍然存在于 `src/sites/youtube/legacy_comment_crawler.ts`，旧路径也已经不再可用。这就是 breaking。

因此这次 commit 用 `refactor(youtube)!: remove legacy route shims`，感叹号是必要的。它不是为了夸张，而是告诉读者：旧 import path 被删除了，调用方需要迁移。

## 为什么这次仍然选择删除

这次用户明确表示“不应该依赖旧的”。这改变了兼容性判断。如果项目需要发布给外部用户，或者有很多无法同步迁移的分支，保留 shim 并给出 deprecation window 会更稳。但当前目标是完成 ECS 边界迁移，继续保留 shim 会让旧 route layer 名义上死了、实际上还活着。

删除后，边界变清楚：

- 新任务入口走 Hono API：`/sites/youtube/tasks/channel` 和 `/sites/youtube/tasks/comments`。
- worker 入口走 `src/sites/youtube/worker.ts`。
- 系统逻辑走 `src/sites/youtube/systems.ts`。
- 页面提取走 `src/sites/youtube/channel.ts` 和 `src/sites/youtube/comments.ts`。
- 临时 legacy Crawlee adapter 只在 `src/sites/youtube/legacy_*` 中显式存在。
- `src/routes/youtube/*` 不再作为兼容入口。

这种清理的价值不是“少三个文件”，而是让未来维护者不再面对两个入口。

## 删除后必须让测试跟着收口

删除 shim 后，如果测试仍然试图通过旧路径覆盖行为，说明清理不完整。这次专门把 raw-store 行为测试迁到 site-layer implementation，并用 source-boundary tests 防止测试继续从旧 route path 引入模块。

这一步比删除文件本身更重要。没有测试收口，旧路径可能很快因为某个“临时兼容”需求被加回来。source-boundary test 把架构决策固定成规则：YouTube 行为测试必须指向 site layer，不能重新保护 retired route import。

## 判断 shim 去留的实用标准

我会用以下标准判断兼容 shim 是否该保留：

- 是否有真实外部调用方暂时无法迁移？如果有，保留并明确 deprecation window。
- 内部新代码是否已经全部迁到新路径？如果没有，先迁内部代码。
- 测试是否还通过 shim 覆盖行为？如果是，先迁测试，否则测试会保护错误边界。
- 文档是否已经说明新入口？如果没有，删除 shim 会让迁移成本变高。
- shim 是否还在服务迁移，还是已经变成旧边界的保护伞？

如果答案指向后者，就应该删除，并明确标记 breaking cleanup。

## 这次经验

兼容层的价值在迁移期，不在永久存在。保留它要有理由和截止条件；删除它要承认破坏性，并给出迁移方向。最差的状态是既没有真正兼容外部用户，又让内部继续依赖旧边界。

这次删除 YouTube route shim 的经验可以概括为：不要把“只有一行 re-export”看成没有成本。只要它保留旧路径，它就在定义 API；只要它定义 API，删除就是 breaking；只要决定 breaking，就要在 commit、文档和测试里同时把边界讲清楚。
