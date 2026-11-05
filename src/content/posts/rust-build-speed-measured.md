---
title: "Rust 编译提速实测：缓存帮不上忙，该修的是链接器和优化级别"
published: 2026-11-05
description: "在 919 个 crate 的 Bevy + Slint 项目上量了 13 组配置：增量构建靠修好 mold 从 24.7 秒降到 9.1 秒，冷构建靠依赖的 opt-level 从 532 秒降到 207 秒，sccache 和 nightly 都没解决问题。"
tags:
  - "Rust"
  - "性能测试"
  - "构建优化"
category: 技术实践
draft: false
---

我在 [osmosis](https://github.com/yebei199/osmosis)（919 个 crate，Bevy + Slint）上量了 13 组构建配置，真正
有效的改动只有三个，没有一个是缓存工具：

| 问题 | 改动 | 之前 | 之后 |
|---|---|---:|---:|
| 增量构建慢 | 让 mold 真正生效 | 24.7 秒 | 9.1 秒 |
| 冷构建慢 | 依赖的 `opt-level` 从 3 降到 0 | 532 秒 | 207 秒 |
| 构建目录大 | 换 nightly | 8.03 GB | 6.49 GB |

mold 是轮流跑 3 轮的均值，另外两行是单次测量。

## mold 写在配置里，但从来没用上

`--timings` 显示，28 秒的增量构建里有 21 秒花在最后一步，主要是链接。我的全局配置早就指定了 mold，它却有
两层没生效：

1. 仓库自己的 `.cargo/config.toml` 写了 `linker = "clang"`，盖住了全局配置。
2. 全局的包装脚本把 flag 放在了前面。rustc 从 1.90 起，遇到认不出的链接器名字会自己传 `-fuse-ld=lld`，而
   clang 取最后一个。

```bash
exec clang -fuse-ld=mold "$@"   # rustc 的 -fuse-ld=lld 排在后面，mold 被盖掉
exec clang "$@" -fuse-ld=mold   # 修好的写法
```

这种失败不报错，只是慢。确认 mold 在工作要看产物，`readelf -p .comment <二进制>` 里应该有 `mold`。

## 冷构建的时间花在优化依赖上

Bevy 项目通常把依赖设成 `opt-level = 3`，不然运行太慢。这个设置决定了冷构建的时间：

| 依赖的 `opt-level` | 冷构建 |
|---|---:|
| 3 | 532.5 秒 |
| 1 | 385.0 秒 |
| 0 | 207.5 秒 |

但 `opt-level = 0` 的产物跑 3D 很慢，所以我没动 `dev`，单独加了一个档，只给不跑 3D 的编译和逻辑测试用：

```toml
[profile.agent]
inherits = "dev"

[profile.agent.package."*"]
opt-level = 0
```

## 缓存省不了日常的时间

sccache 的命中率只有 27%，它不缓存 `bin` 和 `proc-macro`，还要求关掉增量编译。结果是新开一份 worktree 省 2
分钟，每次改代码却要多等：增量 check 从 4.9 秒涨到 17.4 秒。

kache 我留下了，新 worktree 只要 213 秒，sccache 要 410 秒。它第一次改动也要 17 秒，但那是预热，连续改几次
就回到 4.8 秒，和无缓存一样。只测一次会误判。

测 sccache 还有个坑：别用 `CARGO_TARGET_DIR` 给两份检出指定不同目录。`CARGO_*` 环境变量会进缓存键，缓存就
对不上了，我量出来的第二份检出比冷构建还慢。要用 `--config build.target-dir=...`。

## nightly 只省磁盘

省下的 19% 主要来自 nightly cargo 默认传的 `-Z embed-metadata=no`，配置里看不到。这个数字里还混着编译器版本
差异。新闻里的「砍掉 25% 到 50%」不用指望：[官方数据](https://blog.rust-lang.org/inside-rust/2026/08/18/reducing-target-dir-size-on-nightly/)
里带增量和调试信息的 dev 配置只省 4.7% 到 16.3%。

其余特性没有带来多少收益。`-Zbuild-dir-new-layout` 和 `-Zfine-grain-locking` 不省时间也不省磁盘，
`-Zthreads=8` 让冷 check 快 22%，但那是用更多线程换的。Cranelift 在链接 Skia 时失败了。

## 并行爆满没有工具能解决

上面这些只让单次构建更快。多个 agent 并行时，每份 worktree 还是 6 到 8 GB，还是一次全量编译。

所以我最后不再让 agent 在 Rust 仓库里开 worktree，大家留在同一份检出、同一个分支上干活。这条规则放在
`cargo` 的包装入口里，在分支 worktree 里编译会被直接拒绝。
