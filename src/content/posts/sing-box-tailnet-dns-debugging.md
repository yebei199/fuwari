---
title: "sing-box 里一次 Tailnet DNS 误修复的复盘"
published: 2026-06-23
description: "从国内网站和 Tailnet 管理后台互相打断的故障里，总结 sing-box 路由解析与 DNS 规则的边界。"
tags:
  - "sing-box"
  - "v2rayN"
  - "DNS"
  - "NixOS"
category: 技术实践
draft: false
---

这次故障的目标很明确：一个 Tailnet 内部管理后台域名必须能通过代理环境正常打开，同时国内网站也必须正常访问。真正麻烦的是，这两个要求分别卡在 sing-box 的不同环节：Tailnet 域名需要命中 hosts 映射，国内网站不能被 hosts-only 解析器污染。

一开始的错误修复很典型：为了让 Tailnet 域名稳定解析到内网地址，直接给 `direct` 出站加了全局 `domain_resolver = "hosts_dns"`。Tailnet 能通了，但所有走直连的普通域名也被送进只认识少量 hosts 映射的解析器，国内网站开始出现 NXDOMAIN 或连接重置。

## 第一层修复仍然不够

把全局 `domain_resolver` 从 `direct` 出站拿掉，是正确方向，但不是完整答案。

我当时把 Tailnet 域名补进了 `dns.rules`，以为这样 direct 分支解析时会自动使用 `hosts_dns`。实际运行证明不是这样：连接日志仍然显示请求已经走到 `outbound/direct`，但目标域名 lookup 失败。也就是说，普通 DNS 查询规则存在，不代表 route/outbound 在连接目标域名时一定会用它。

这个误判的教训是：在 sing-box 里要分清两类解析。

- `dns.rules` 负责 DNS 请求本身怎么处理。
- route 阶段连接目标域名前，也可能需要明确的解析动作。

如果目标是“这个域名在进入 direct 出站前先解析成 hosts 里的地址”，只写 DNS rule 可能不够。

## 最终有效的最小模型

最终修复没有恢复 direct 出站的全局 resolver，而是在 route 规则前面插入一条只匹配 Tailnet 域名的 resolve action：

```json
{
  "action": "resolve",
  "server": "hosts_dns",
  "domain": ["<tailnet-host>"],
  "domain_suffix": ["<tailnet-domain-suffix>"]
}
```

然后紧接着保留 Tailnet 域名和 Tailnet 网段的 direct 路由。这样路径变成：

1. Tailnet 域名先由 `hosts_dns` 解析。
2. 解析后的连接继续走 `direct`。
3. 普通直连域名不带全局 `domain_resolver`，继续使用正常解析器。

这个模型比“给 direct 出站加全局 resolver”多一条规则，但边界更窄：只处理需要 hosts 映射的 Tailnet 例外，不改变国内网站、镜像站、普通直连域名的解析方式。

## 测试应该防两类回归

这次补测试时，不能只检查“Tailnet 规则存在”。真正要守住的是两个方向：

- Tailnet 域名必须在 route 阶段通过 `hosts_dns` resolve。
- `direct` 出站不能再有全局 `domain_resolver`。

前者防止内部管理后台域名再次解析失败；后者防止国内网站再次被 hosts-only 解析器误伤。

这类代理配置测试里，“不要做什么”往往比“做了什么”更重要。因为一条过宽的默认规则看起来能修一个点，但会悄悄改变整条分流链路。

## 激活路径也要纳入排障

另一个容易漏掉的点是 NixOS 激活。修复提交进仓库不代表正在运行的用户服务已经使用了新 wrapper。旧服务仍然可能继续重写运行态 sing-box 配置，所以只重启服务未必能验证新代码。

当代理本身坏掉，而系统切换又要通过代理下载依赖时，还会出现 bootstrap 问题：国内 substituter 可能正好走坏掉的直连分支。那时更稳的做法是临时改用能通的 substituter 构建出系统闭包，再用已构建的 store path 切换。

这个经验可以简化成一句话：代理修复必须验证“仓库配置、运行态配置、systemd 服务指向、浏览器最终路径”四件事，少一个都可能是假修复。

## 以后遇到类似问题先问三句

1. 失败域名最终进了哪个 outbound？
2. 进入 outbound 前，它到底由哪个 resolver 解析？
3. 当前修复是精确匹配例外，还是改了共享默认值？

如果答案里出现“全局 resolver”“默认 direct”“所有直连域名”这类词，就要特别小心。代理配置里最省事的一行，往往也是最容易扩大故障面的那一行。
