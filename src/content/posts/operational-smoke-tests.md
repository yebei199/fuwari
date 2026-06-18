---
title: "默认门禁和真实 smoke 必须分层"
published: 2026-06-18
description: "为什么 Crawle 把 Postgres/RabbitMQ、YouTube worker 和 Zhihu live login 放进不同验证层级。"
tags:
  - "Smoke Test"
  - "Postgres"
  - "RabbitMQ"
category: 技术实践
draft: false
---

这次重构后期，关于验证边界有一个反复出现的问题：真实 Postgres/RabbitMQ、真实浏览器和真实账号登录要不要进入默认门禁？我的结论是不要，但这不等于不验证真实链路。正确做法是分层。

默认门禁要稳定、快速、可重复。它应该验证项目内可控 contract，而不是依赖本机是否启动 RabbitMQ、Postgres 数据库是否干净、Chromium 是否安装完整、YouTube DOM 是否今天没变、知乎账号是否能扫码。默认门禁一旦变脆，开发者很快会开始绕过它。

## 默认 verify 负责可重复契约

`bun run verify` 适合覆盖单元测试、fake bus 集成、in-memory/Prisma store contract、API contract、scheduler、worker state machine、parser、migration dry-run、source-boundary tests 和通用 Playwright 示例。这些测试不需要真实账号，不需要外部网站稳定，也不需要长期运行。

这类测试的目标是回答：我们自己的边界是否正确？错误输入是否被拒绝？取消和 terminal state 是否稳定？store 实现是否语义一致？旧路径是否被防回流？消息 adapter 是否正确处理 confirm/prefetch/close？这些都应该在默认门禁里频繁跑。

默认门禁通过，不代表生产环境永远可靠。它只代表代码层面的可重复契约没有破坏。这句话要说清楚，否则团队容易把一次 verify 通过误读成“真实世界也稳定”。

## Service smoke 负责真实 DB/MQ 链路

service smoke 是下一层。它需要 disposable Postgres 和 RabbitMQ，验证 API 创建 job、Prisma store 写 ECS/outbox、RabbitMQ adapter publish、outbox event 标记 published。这条链路不依赖真实站点，也不需要浏览器，它验证的是服务基础设施。

这类 smoke 不适合默认运行，因为它依赖外部服务。但它必须有标准入口。Crawle 最终把它做成 opt-in test，并在 Justfile 里提供 `test-service-smoke` recipe，复用共享本地测试数据库 URL helper，同时要求显式 `RABBITMQ_URL` 等配置。

这种设计比“偶尔手动跑一下”更可靠。它不污染默认门禁，但当需要验证真实 DB/MQ 时，有明确命令和文档。

## YouTube worker smoke 负责真实浏览器 worker 链路

YouTube worker smoke 更靠近端到端。它需要真实浏览器、真实 public YouTube channel URL、Postgres、RabbitMQ。流程是：API 创建 YouTube channel job，outbox 发布 command，worker 消费，Playwright 打开页面，collector 提取 video items，系统写 raw items，job 状态完成。

这条链路很有价值，因为它会暴露 fake tests 看不到的问题。重构中它就暴露了当前 YouTube DOM drift，channel extraction 需要接受 `/watch` anchor with text or aria titles。修复后，新的 DOM 规则被写回稳定 browser port tests。

但这条 smoke 仍不适合默认门禁。YouTube 页面可能变化，网络可能波动，Chromium 可能缺失，公共页面可能不可访问。把它塞进默认 verify，会把外部不稳定性变成开发门禁不稳定性。

## Zhihu live smoke 是人工验证层

知乎 QR login/feed live smoke 又是另一层。它需要真实账号、人工扫码和可用 session。用户已经明确说这部分可以不用验证，所以这次把它作为明确豁免记录，而不是强行伪装成自动测试。

这类验证如果要做，应该是手动或半自动流程：运行登录 smoke，生成 QR artifact，通过 API 或前端取二维码，人工扫码，保存 session component，再运行 feed crawl smoke。它验证的是人机交互和真实账号路径，不应该影响默认开发门禁。

明确豁免比含糊跳过更专业。因为它告诉后续维护者：这里不是忘了，而是本阶段接受的验证边界。

## 长期可靠性不是一次 smoke 能证明

用户之前指出“真实 Postgres/RabbitMQ 环境的长期稳定验证只能跳过”。这个判断方向是对的，但要更精确：默认门禁跳过长期稳定性，opt-in smoke 验证真实链路能跑通一次，长期稳定性需要运维验证。

一次 service smoke 不能证明 RabbitMQ 网络抖动后的恢复能力。一次 YouTube worker smoke 不能证明浏览器 worker 连续跑 20 小时没有资源泄漏。一次 verify 不能证明数据库连接池在高并发下稳定。长期可靠性需要 soak test、指标、日志、告警、故障注入、重启演练和容量观察。

把长期可靠性写进“默认测试必须证明”的目标，是不现实的。更好的做法是把它作为 operational risk 记录，并提供后续验证路径。

## 为什么分层能降低误判

分层后，失败更容易定位。默认 verify 失败，大概率是代码 contract 被破坏。service smoke 失败，要检查 Postgres/RabbitMQ 配置、schema、outbox publish 和 adapter。YouTube worker smoke 失败，要额外检查 Chromium、网络、YouTube DOM、站点 collector。Zhihu live smoke 失败，还要考虑账号、扫码、session 和风控。

如果这些全在一个命令里，失败原因会混在一起。开发者看到红灯，不知道是自己刚改坏了 worker 状态机，还是 YouTube 页面今天变了。长期来看，这会让团队不信任测试。

测试的可诊断性和测试的覆盖面一样重要。一个经常因为外部环境失败的门禁，不是高标准，而是低信噪比。

## 文档和命令入口同样重要

opt-in test 如果没有文档，等于半隐藏脚本。Crawle 的 `tests/README.md` 记录了 service smoke、YouTube worker smoke 和 Zhihu manual specs 的运行方式；Justfile 提供了 `test-service-smoke` 和 `test-youtube-worker-smoke`。这让验证不依赖某个人记得一串环境变量。

文档还要说明跳过原因。比如 smoke tests 默认 skip 是因为需要 disposable services 和显式 env；Zhihu specs 默认 skip 是因为需要人工登录；这比简单写“skipped”更有用。

## 我会复用的验证分层模型

以后类似项目，我会按四层设计验证：

1. Default gate：纯代码 contract，必须稳定，开发者频繁运行。
2. Adapter integration：真实 adapter 行为，但尽量可控，例如 RabbitMQ confirm/prefetch fake 或 disposable broker。
3. Opt-in smoke：真实 DB/MQ/browser/site 链路，显式环境变量，不能默认阻塞开发。
4. Operational validation：soak、监控、告警、故障注入、资源泄漏观察。

每层都要有不同目标，不要互相冒充。default gate 不证明生产稳定；smoke 不替代单元测试；soak 不替代 schema validation；人工 live smoke 不应该影响日常提交。

这次 Crawle 的经验是：服务越依赖外部系统，越需要验证分层。把所有东西塞进一个“最终门禁”看起来严格，实际会让门禁不可用。把每层目标讲清楚，反而能更诚实地管理风险。
