---
title: "用 CRAP 门禁倒逼 Rust 运维代码拆分"
published: 2026-06-17
description: "一次 cargo crap 失败暴露了运维编排函数的复杂度债务，修复重点不是绕过门禁，而是把副作用密集的流程拆回可验证边界。"
tags:
  - "Rust"
  - "质量门禁"
  - "重构"
category: 技术实践
draft: false
---

这次问题表面上是一个命令没过：

```bash
cargo crap --workspace --lcov lcov.info --threshold 30 --fail-above
```

但真正值得记录的不是工具本身，而是它指出的问题类型：新加的 infra-k8s 本地镜像导入路径没有超标，相关脚本函数在报告里是 CRAP 1.0、100% 覆盖；失败来自仓库里既有的大函数，它们把 CLI 分发、远端副作用、参数校验、输出渲染和错误处理揉在一起，复杂度高，直接覆盖率又低。

这类失败很容易被误判成“覆盖率不够”。实际看下来，补测试并不是最有效的第一步。远端 SSH、Docker、Cloudflare、R2、代理探测这些路径都有副作用边界，强行给每个大函数补单元测试，最后会得到一堆脆弱的 mock，而不是更清楚的设计。

## 先确认失败归因

第一步是重新生成 LCOV，再跑 CRAP：

```bash
cargo llvm-cov nextest --workspace --lcov --output-path lcov.info
cargo crap --workspace --lcov lcov.info --threshold 30 --fail-above
```

这里有两个细节很关键。

第一，CRAP 报告要和 LCOV 同一轮测试结果对应，否则容易追错目标。第二，`--fail-above 30` 的语义是“高于 30 才失败”，所以 CRAP 正好等于 30 的函数只是警告，不是这次必须处理的失败项。

报告里还会提示部分测试源文件没有 LCOV entry。只要这些是 integration test 或 test-only 模块，而产品 crate 仍然有 coverage 和 CRAP 汇总，这类警告可以记录但不必当作产品覆盖率错误。相反，如果缺的是产品源文件，就应该先检查 coverage 配置。

## 不用 allowlist 掩盖设计问题

这次没有选择给既有函数加豁免。原因很简单：门禁指出的是实际维护成本。

例如 `ops` 的命令处理原本集中在一个大文件里。它既负责顶层 dispatch，又包含 data tunnel、service deploy、backup、Infisical、proxy、image、R2 等命令的细节。这样的结构短期方便追加功能，长期会让每个新命令都承担旧复杂度的成本。

更稳的做法是把编排拆回职责边界：

- `ops` 顶层只保留命令分发，具体命令搬到 `commands/` 子模块。
- Compose 部署拆开规划、文件同步、本地镜像导入、`compose up`、post-deploy 和健康检查。
- Transport 保留公开 `Transport` API，把 SOCKS5/direct dial、本地 TCP forwarding 和测试拆到私有子模块。
- Cloudflare、R2、proxy、image manager 里的请求构造、执行和响应校验分离。

这不是为了追求“函数越小越好”。拆分的标准是：一个函数是否还在同时理解多个外部系统、多个分支策略和多个副作用阶段。如果是，就很难写出稳定测试，也很难在出错时定位边界。

## 测试重点放在可观察行为

运维代码最容易被测试拖歪。很多行为的真实结果在远端主机上，单元测试无法也不应该真的 SSH、Docker 或改 Cloudflare。

这次保留下来的测试策略是 dry-run 和 hermetic 单元测试：

- dry-run 断言命令输出里包含关键步骤，比如镜像上传、k3s 导入、`kubectl apply`。
- dry-run 同时断言不再出现 GHCR token、`ghcr-read` 等旧路径。
- 配置校验仍覆盖 Kubernetes app 所需字段。
- Transport 的本地转发测试只验证 dry-run 不绑定端口、端口冲突会在 SSH 前失败。

这样测试验证的是用户可观察契约，而不是强行模拟整条远端执行链。对运维 CLI 来说，这比 mock 一堆底层客户端更有价值。

## 文件大小约束也会暴露模块边界

修 CRAP 之后又遇到一个仓库级约束：Rust 文件不能超过 700 行。`ops/src/commands.rs` 和 `transport/src/transport.rs` 都被本次触碰过，不能假装没看见。

这一步反而帮助确认了拆分是否合理。`ops/src/commands.rs` 被压成薄分发层，命令域分别进入 `backups.rs`、`data.rs`、`service.rs`、`proxy.rs` 等文件。`transport.rs` 保留主 API，拨号和 forwarding 进入私有目录。每个新目录补了 README，用一句话说明责任边界。

文件大小限制本身不是设计原则，但它能防止“修复杂度”只停留在函数层面，而把模块边界继续堆在同一个文件里。

## 最终门禁

修复后的验证链包括：

```bash
cargo fmt -p ops -p infra-compose -p infra-transport -p infra-images -p infra-proxy -p infra-providers -p infra-operations --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo nextest run --workspace
cargo llvm-cov nextest --workspace --lcov --output-path lcov.info
cargo crap --workspace --lcov lcov.info --threshold 30 --fail-above
```

最终结果是 434 个函数被分析，0 个超过 CRAP 阈值 30。这个结果比“把本次新增函数证明没问题”更有意义：它把仓库里已经阻塞门禁的复杂度债务一起降下来了。

## 可复用的结论

CRAP 门禁适合用来发现两类问题：分支多但没覆盖的函数，以及覆盖率看似可以但职责混杂的函数。遇到失败时，不要马上在测试里复刻内部实现，也不要急着加 allowlist。先问三个问题：

1. 失败函数是不是同时做了编排、校验、远端副作用和输出？
2. 能不能把纯决策和副作用执行拆开，让测试覆盖前者，让 dry-run 覆盖后者的可观察命令？
3. 这次拆分是否让下一次功能变更更容易定位边界？

如果答案是肯定的，重构通常比补一层脆弱测试更划算。

不过这个方法也有边界。对于核心算法或纯业务规则，优先补覆盖率和边界测试通常更直接；对于远端系统编排，先拆职责，再围绕 dry-run、脚本生成和配置校验建立测试，收益更稳定。
