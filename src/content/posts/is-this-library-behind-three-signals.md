---
title: "发版停了十九个月，代码却天天在动"
published: 2026-09-10
description: "有人问 Rust 的 eBPF 库 Aya 落不落后。查下来「落后」是三个互相独立的信号，而最容易踩的坑是数提交数时把每条记录数了两遍。"
tags:
  - "Rust"
  - "eBPF"
  - "Aya"
  - "开源调研"
  - "GitHub API"
category: 技术实践
draft: false
---

有人问我 Rust 写 eBPF 有没有现成的 SDK，接着追了一句：Aya 会落后很多吗？

第二个问题比第一个有意思。「落后」在开源项目上其实指三件不同的事，它们各自有各自的证据来源，
而且可以互相矛盾——这次就矛盾了。

## 背景，一段说完

eBPF 是 Linux 内核里的沙箱虚拟机：把一小段程序挂到内核事件上，内核先验证再执行，不改源码不装
模块。Rust 这边两条路，Aya 是纯 Rust，内核侧和用户态都用 Rust 写，编译走 rustc 自带的 BPF
target；libbpf-rs 是用户态 Rust 封装 libbpf，eBPF 程序本身还是 C，用 clang 编。问「落不落后」
问的是前者。

## 信号一：发布节奏

主 crate `aya` 的版本时间线很干脆：0.13.1 发在 2024-11-01，下一个 0.14.0 发在 2026-06-24。中间
十九个多月，crates.io 上一动不动。

只看这一个信号，结论会是「这项目半死不活」。

范围要说清楚：说的是主 crate。同一个 monorepo 里 `aya-ebpf-bindings` 在 2025-11 发过 0.1.2。
monorepo 里各个 crate 的版本号各走各的，只盯一个包名会看错整个仓库的状态。

## 信号二：提交活跃度，以及我数错的那一次

第一次数是这么干的：

```bash
curl -s "https://api.github.com/repos/aya-rs/aya/commits?per_page=100" \
  | grep -oE '"date": "[0-9]{4}-[0-9]{2}' | sed 's/.*: "//' | sort | uniq -c
```

得到 2026-07 有 69 条、2026-08 有 95 条。一百条提交里冒出一百六十多条月份记录，这时候就该停下来。

原因是每条 commit 记录里有两个 date：`commit.author.date` 和 `commit.committer.date`，字段名
一模一样，grep 一网打尽。换成真的解析 JSON：

```bash
curl -s "https://api.github.com/repos/aya-rs/aya/commits?per_page=100" | python3 -c "
import sys, json, collections
c = collections.Counter(x['commit']['author']['date'][:7] for x in json.load(sys.stdin))
for k in sorted(c): print(k, c[k])
"
```

真实数字是 7 月 30 条、8 月 47 条。

值得注意的是它不等于「除以二」——69 对 30，95 对 47，都差着一点。两个日期可以落在不同月份，
rebase 或者 cherry-pick 过的提交尤其明显。所以发现重复计数之后，唯一正确的动作是重数，不是
把错的数字修一修。

同样口径下的 libbpf-rs：7 月 26 条、8 月 9 条。

还有一个窗口问题：`per_page=100` 拿到的是最近一百条提交，不是最近一年。两个仓库各自的一百条
覆盖的时间跨度不一样（Aya 回溯到 2025-10，libbpf-rs 到 2025-11），拿来做月度对比之前得先确认
两个窗口重叠。

所以信号一和信号二在这个项目上直接打架：crates.io 静默十九个月，主干却是这两个月里更忙的
那一个。

## 信号三：功能覆盖，读代码不读 README

「缺什么」这件事 README 上永远不会写。对 eBPF 库来说有两个地方值得读：用户态那边的程序类型
模块列表，和对象解析器里的段名（section name）匹配表。后者尤其诚实——一个程序类型只要段名
解析不认，用户就写不出来。

Aya 的模块列表覆盖得相当全：kprobe、uprobe、tracepoint、fentry/fexit、LSM 及 lsm_cgroup、
XDP、TC（含新的 TCX）、cgroup 全家、sk_lookup/sk_msg/sk_skb/sk_reuseport、sock_ops、iter、
flow_dissector、perf_event、raw_tracepoint、extension、lirc_mode2。

段名解析表里查出来三条缺口：

- **multi 挂载只有 uprobe 有。** `uprobe.multi`、`uretprobe.multi` 以及它们的 sleepable 变体都
  认，`multi` 标志置真；kprobe 和 kretprobe 的分支里 `multi` 是写死的 false，`kprobe.multi`
  这个段名根本不在表里，kprobe 那个文件里连 multi 这个词都搜不到。
- **netfilter 程序类型没有。** 模块列表里没有，段名解析里也没有。
- **struct_ops 没有。** 这条挡住的是 sched_ext，也就是用 eBPF 写内核调度器那条线。需求单是
  aya-rs/aya#967，2024-06-12 开的，到现在还开着。

这三条决定了选型的分界线：做观测、追踪、网络包处理，Aya 不缺什么；要碰 sched_ext 或
netfilter，现在还得走 libbpf-rs。

## 三个信号该怎么合

它们回答的不是同一个问题：

- 发布节奏回答「我 `cargo add` 之后拿到的东西有多旧」。
- 提交活跃度回答「这项目还有没有人在管」。
- 功能覆盖回答「我要用的那个东西到底有没有」。

只看第一个会把 Aya 判死；只看第二个会以为随便上；只有第三个能直接回答「我这个活能不能干」。
真正做选型的时候，第三个是唯一必须查的，前两个是用来判断「现在缺的东西，将来会不会补上」。

## 这套方法的边界

只回答活不活、缺不缺，不回答好不好用。API 曲不曲折、文档全不全、编译报错友不友好，这些得真
写一遍才知道，查仓库查不出来。

`open_issues_count` 这个字段包含 PR，Aya 那个两百多的数字里有多少是 PR 我没拆，所以我没拿它
当活跃度证据。

有一条我没验证：发版空窗期里，社区项目和教程有多少直接依赖了 git 分支而不是 crates.io 版本。
我猜不少，但没统计过，写在这里只当猜测。
