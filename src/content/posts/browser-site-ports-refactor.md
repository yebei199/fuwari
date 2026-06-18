---
title: "浏览器爬虫要先收窄端口"
published: 2026-06-18
description: "从 Zhihu QR 登录和 YouTube 页面采集看，如何把 Playwright/Crawlee 放回 adapter 位置。"
tags:
  - "Playwright"
  - "Crawlee"
  - "爬虫"
category: 技术实践
draft: false
---

浏览器爬虫最容易把架构边界拖乱。它需要启动 browser、创建 context、打开 page、监听 response、等待 selector、滚动页面、截图、读取 cookie，还可能需要人工扫码。只要这些细节直接散落在业务系统里，测试就会被真实浏览器绑住，状态也会被回调和脚本流程绑住。

这次 Crawle 重构里，一个重要原则是先收窄 browser port：系统层只依赖站点动作需要的最小接口，不依赖完整 Playwright page，也不依赖 Crawlee 的全局运行时。Playwright/Crawlee 可以继续存在，但它们被放回 adapter 位置。

## 为什么不能让 Page 泄漏到系统层

完整的 Playwright `Page` 能做太多事。它可以导航、点击、监听、注入脚本、截图、读 cookie。系统一旦直接拿到 `Page`，很容易在业务逻辑里散落浏览器细节：这里 wait 一下，那里截个图，这里顺手读 cookie，那里顺手写数据库。短期开发很方便，长期测试和清理会变得很难。

窄 port 的目的不是“多抽一层”，而是把系统需要的能力说清楚。知乎 feed capture 需要的是“捕获符合条件的响应”；知乎 QR login 需要的是“生成二维码 artifact 并在扫码后取得 session”；YouTube channel collector 需要的是“给定 channel URL，返回 video items”；YouTube comment collector 需要的是“给定 video URL，滚动并返回 comment items”。

这些接口都可以被 fake。系统测试不需要真的打开浏览器，就能验证 job state、artifact 写入、raw item persistence 和 cancellation semantics。真实 Playwright adapter 则可以用更窄的测试验证 DOM extraction 和资源清理。

## Zhihu QR 登录：从本地图片查看器变成 artifact

旧登录流程的问题不是“能不能扫码”，而是不适合服务形态。如果 worker 在服务器上打开本地图片查看器，等于假设有桌面环境；如果二维码落在本地文件里，API 层就很难把它暴露给用户；如果 session 只存在 cookie 文件或进程内对象里，服务重启后就不可恢复。

新流程把 QR 登录拆成服务化动作。登录系统生成 QR artifact，job state 进入等待扫码状态，API 可以查询 artifact；人工扫码后，系统捕获 cookie/session 并保存为 session component。这样前端或调用方可以通过 API 获取二维码，worker 不需要弹窗，也不需要把会话材料写进源码。

这也让测试边界清楚。自动测试可以验证 artifact 创建、media type、job state、session schema 和 persistence；真实扫码属于 opt-in live smoke，默认门禁不依赖真实账号。人工步骤被承认，而不是被伪装成自动化。

## Zhihu feed：监听响应也要变成系统边界

feed 抓取不是单纯 DOM parsing。知乎推荐流更适合监听网络响应，再从响应里解析 answer/article raw items。旧流程如果把监听、解析、去重和入库写在一个浏览器脚本里，任何失败都很难定位。

重构后，response capture 成为一个系统，parser 成为一个系统，dedupe/persist 成为 store 行为，mark completed 成为明确状态转移。这样 response capture 的输入输出可以被测试，parser 可以单独验证 HTML text extraction、广告过滤、content hash，persist 可以验证 raw item uniqueness。

这类拆分的经验是：浏览器回调不是业务边界。回调只是 adapter 收集事实的方式，系统边界应该围绕可持久化状态设计。

## YouTube：把页面采集从 route 中拿出来

YouTube 的问题更偏 legacy 结构。channel/comment route 模块、Crawlee adapter、raw store 和 item types 曾经相互纠缠。迁移时没有直接把所有旧代码删掉，而是分几步收窄边界：先把 item types 放到 `src/sites/youtube/types.ts`，再把 channel extraction 放到 `channel.ts`，把 comment extraction 放到 `comments.ts`，再把 legacy raw store 放到 site layer，最后接入 ECS systems 和 worker。

这个顺序避免了一次性大爆炸。每一步都有对应测试：browser port extraction、raw store behavior、worker command registry、API task validation、source-boundary。等新边界稳定后，旧 `src/routes/youtube/*` shim 才被删除。

YouTube live smoke 还暴露了 DOM drift：当前 channel 页面里 `/watch` anchor 的形态和测试假设不完全一致。修复不是把 smoke 放进默认门禁，而是把新的 extraction fallback 写进稳定测试。live smoke 负责发现外部变化，单元测试负责固化我们对变化的适配。

## Crawlee 的正确位置

这次没有否定 Crawlee。Crawlee 仍然可以作为 legacy execution adapter，帮助运行旧 channel/comment crawler。问题在于 Crawlee 不应该拥有全局任务状态，也不应该让 route module 成为业务入口。

新 ECS 路径里，任务从 API 创建，状态在 Postgres，命令通过 RabbitMQ，worker 运行 systems，raw items 写 ECS store。Crawlee/Playwright 只负责执行页面动作。这种分工让浏览器框架可以替换或升级，而不影响 job state、outbox、artifact、raw item 和 API contract。

这条原则可以推广：框架负责执行机制，领域层负责状态语义。只要反过来，框架生命周期就会绑架业务生命周期。

## Browser lifecycle 是 port 的一部分

收窄 port 不只关乎方法签名，也关乎资源所有权。worker starter 要负责创建 browser/context/page，也要负责关闭它们。后期测试补了 context cleanup 失败仍关闭 browser、worker cancellation 失败后继续 service cleanup、browser pool 在 shutdown 中关闭等路径。

这类错误很容易被忽略，因为单次测试可能不会马上暴露资源泄漏。但长期服务会把每个泄漏放大。浏览器资源比普通 HTTP client 更重，关闭路径必须和启动路径一样认真设计。

配置开关也是 lifecycle 的一部分。重构后默认 runtime 可以启动 Zhihu 和 YouTube browser workers，同时支持 `ZHIHU_WORKER_ENABLED=false` 和 `YOUTUBE_WORKER_ENABLED=false`。不同环境可以只跑 API、只跑某个 worker，或者禁用真实浏览器路径。这是服务化部署需要的弹性。

## 设计 browser port 的实用标准

以后再设计站点 browser adapter，我会用以下标准：

- port 方法名应该表达站点动作，而不是 Playwright 操作。
- port 返回值应该是系统需要的结构化数据，而不是 `Page` 或 DOM handle。
- 系统测试应该能用 fake port 覆盖状态变化。
- adapter 测试再覆盖 selector、response filtering、scrolling 和 extraction。
- session/cookie 只能通过 schema validation 后保存，不允许写源码或散落文件。
- QR、截图、下载内容这类产物应该成为 artifact，而不是本地桌面行为。
- browser/context/page 的关闭路径必须被测试覆盖。

这次最大的经验是：浏览器世界不可控，系统边界必须可控。把 Playwright/Crawlee 放在 adapter 层，不是为了抽象纯洁，而是为了让长期爬虫服务在外部页面变化、浏览器失败和人工登录介入时仍然能保持可解释状态。
