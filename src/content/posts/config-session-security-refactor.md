---
title: "重构里最不能顺手带过的是配置和 Session"
published: 2026-06-18
description: "从 Crawle 清理硬编码 cookie、统一 env 校验和重做登录 artifact 的过程，复盘爬虫项目的安全边界。"
tags:
  - "安全边界"
  - "配置管理"
  - "爬虫架构"
category: 技术实践
draft: false
---

爬虫项目特别容易把安全边界写坏。为了快速验证，先把 cookie 粘到源码里；为了复用浏览器状态，先把 session 文件路径写死；为了模拟请求，先把 headers 放进 helper；为了登录方便，先在本地打开二维码图片。每一步都有现实理由，但当项目从脚本变成长服务，这些“先这样”会变成最难清理的风险。

这次 Crawle ECS 重构里，配置和 session 不是附属工作，而是架构迁移的一部分。因为 session 决定账号身份，cookie 决定站点访问权限，env 决定服务连接哪些外部系统，artifact 决定敏感材料如何被暴露。只要这些边界没理清，所谓 ECS、outbox、worker 都可能在安全上站不住。

## 硬编码会话材料不是技术债，而是已暴露事实

很多团队会把源码里的 cookie 当成普通技术债，觉得“之后删掉就行”。这个判断太轻。只要 cookie、headers、session material 进入过源码或提交历史，就应该按已暴露处理。正确动作不是只删除代码，还要废弃或轮换对应账号 session，并防止类似材料再次进入仓库。

这次重构明确要求移除源码里的硬编码 cookies、headers 和 session material，并把配置统一收口到 env + Zod 启动校验。这个动作不只是为了代码整洁，而是为了把敏感输入从版本控制里移出去。版本控制适合保存结构和规则，不适合保存身份材料。

更实际地说，源码中的 session 还会污染测试和部署。测试环境可能无意中使用真实账号，CI 日志可能打印敏感字段，开发者本地分支可能保留过期 cookie，worker 失败时可能把 header 片段写进错误信息。把这些材料留在代码里，会让每一层边界都更难守。

## Env 校验要在启动时失败，而不是运行到一半失败

长期服务依赖 `DATABASE_URL`、`RABBITMQ_URL`、API host/port、proxy、browser options 等配置。配置缺失或格式错误时，最好的失败点是启动阶段。服务启动不起来很烦，但比运行到创建 job 后才发现 RabbitMQ URL 错误要安全得多。

这次通过 Zod schema 读取 env，让配置在 service bootstrap 时被校验。比如 API 默认绑定 `127.0.0.1`，只有显式配置才对外监听；RabbitMQ URL 必须是 worker 能用的 AMQP endpoint，而不是管理 UI 的 `15672`；browser 和 proxy 选项也应该通过结构化配置进入系统。

这个策略的价值是把配置错误从业务路径中移出。worker 不应该在执行知乎 feed 系统时才发现缺少数据库连接；outbox publisher 不应该在扫描 pending event 后才发现 RabbitMQ endpoint 指向管理 UI；API 不应该因为 port 配置模糊而意外暴露到公网。

## Session 应该是组件，不应该是散落文件

脚本里 session 常常是一个 cookie json 文件，路径写在脚本旁边，谁需要谁读取。长期服务里，这种方式无法表达归属、版本、状态、更新时间和失效原因。一个账号可能有多个 session 尝试，一个 session 可能过期，一个 job 可能依赖特定 account，一个 worker 可能需要判断 session 是否可用。

Crawler-domain ECS 让 session 成为 entity/component 语义的一部分。账号是 account entity，登录结果是 session component，job 引用 account/session，系统运行时通过 store 读取。组件通过 schema 校验，保存 versioned JSONB，必要时可以记录更新时间和状态。

这个模型让 session 从“文件里的秘密”变成“有生命周期的状态”。它仍然需要保护，仍然不能随便打印，但至少系统知道它属于哪个 account、由哪个流程产生、是否还可用、失败时该如何解释。

## 二维码不是本地交互，而是服务 artifact

知乎登录最能体现脚本和服务的差异。脚本里，打开二维码图片或本地查看器很自然，因为运行者就在机器前。服务里，worker 可能跑在远程主机、容器或后台进程，本地图片查看器没有意义，还会制造不可测试副作用。

这次登录 QR system 改成生成 artifact。API 创建 login job 后，用户可以查询 job artifact，拿到二维码状态并人工扫码。扫码成功后，系统保存 session component。这个设计让人工动作仍然存在，但它不再依赖 worker 所在机器的桌面环境。

更重要的是，artifact 可以被纳入任务状态。二维码是否生成、是否过期、登录是否成功、session 是否保存，都可以通过 job 状态和 artifact 解释。脚本式本地查看器只是一瞬间的 UI 行为，不适合作为服务协议。

## 日志和错误里不能顺手泄漏敏感字段

配置和 session 安全不只发生在输入端，也发生在失败端。migration dry-run、worker error、RabbitMQ publish error、API validation error 都可能把上下文写进日志。如果错误对象里带了 cookie、headers 或 raw session，就可能在排查时二次泄漏。

这次迁移 CLI 和相关测试关注了 redaction，也就是迁移报告和错误输出不应该暴露敏感材料。这个细节很容易被忽略，因为开发时最想看到完整上下文。但长期服务的日志常常会进入集中系统、工单、截图和外部协作渠道，不能默认安全。

一个可复用的标准是：标识符、计数、hash、状态和错误类别可以记录；原始 cookie、authorization header、完整 session blob、二维码敏感 payload 不应该进入普通日志。需要排查时，也应该通过受控 artifact 或本地调试路径处理，而不是扩大默认日志暴露面。

## Browser profile 和账号状态不能混成全局资源

浏览器爬虫常常会用 persistent profile 复用登录态。这个方式有效，但如果它被设计成全局路径，就会带来账号串线和测试污染。不同账号、不同站点、不同 job、不同环境可能共享同一个 profile，最后很难解释某个请求到底用了谁的 session。

这次重构没有把 Crawlee 或 Playwright 的 profile 当作全局状态源，而是让浏览器 adapter 消费明确的 session/account 状态。真实浏览器可以有缓存或上下文，但它不能替代数据库里的 session component。这样即使 profile 损坏或丢失，系统仍然能知道任务依赖什么状态，并给出可恢复路径。

对于多账号爬虫，这一点尤其重要。账号状态必须能被查询、隔离、废弃和轮换。全局浏览器 profile 只适合本地实验，不适合服务内核。

## 配置安全和测试也要绑定

如果安全规则只写在文档里，很容易被下一次快速验证破坏。更稳妥的方式是把关键禁令写进测试或 source-boundary checks。比如源码不能包含硬编码 cookie/session material，旧 cook helper 不能回流，env schema 必须拒绝缺失或非法配置，API 错误输入不能创建持久状态。

这类测试不会证明绝对安全，但会挡住最常见的回退。大重构后期最容易出现“临时先塞一个 header 让测试过”的冲动，source-boundary test 的作用就是让这种临时动作立刻变红。

安全边界也应该进入 review checklist。每个新增站点系统都要问：它从哪里读 session？是否会打印敏感内容？artifact 是否可能暴露账号材料？失败时是否会把 headers 带进 error？测试 fake 是否和真实 session 结构混在一起？

## 这次给我的具体经验

第一，移除硬编码 secret 不能只看当前文件，还要考虑提交历史和账号轮换。源码清理是必要动作，不是完整处置。

第二，env schema 是服务启动协议的一部分。缺少 DB/MQ/proxy/browser 配置时，早失败比半路失败更容易恢复。

第三，session 要有归属和生命周期。把它放进 ECS component，不是为了抽象，而是为了表达 account、job、状态和版本之间的关系。

第四，人工登录也要服务化。二维码可以需要人扫，但不应该依赖 worker 的本地桌面环境；artifact 是比本地图片查看器更适合服务的边界。

第五，日志默认不可信。任何可能离开本机的输出，都应该避免原始 session、cookie、authorization header 和二维码敏感 payload。

配置和 session 看起来不像架构核心，但它们决定架构是否能安全落地。爬虫服务一旦跑成长期系统，身份材料就是生产数据，不能再按脚本临时变量处理。
