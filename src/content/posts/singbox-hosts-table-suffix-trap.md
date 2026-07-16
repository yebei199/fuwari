---
title: "把上次的正确修复用过头:sing-box 静态 hosts 表的后缀陷阱"
published: 2026-07-16
description: "一个公网域名被塞进只有一条记录的静态 hosts 表,于是直连规则明明生效,连接却照样被重置。"
tags:
  - "sing-box"
  - "DNS"
  - "Tailscale"
  - "调试"
category: 技术实践
draft: false
---

上一篇《sing-box 里一次 Tailnet DNS 误修复的复盘》最后给出的最小模型是:在 route 规则前插一条只匹配 Tailnet 域名的 `resolve` action,让它先经 `hosts_dns` 解析,再走 `direct` 出站。那个模型是对的,现在还在跑。

这次的故障,是我把那个模型用到了一个它根本不该管的域名上。

## 症状:规则生效了,但没用

起因是给内网服务加了个 https 入口,一个新后缀,姑且叫 `svc.example.net`。它指向 Tailnet 里那台机器的 CGNAT 地址。我给它加了直连规则,rebuild,然后发现访问不了。

第一反应是问:是不是要重启 sing-box?

这个反应本身就值得记一笔。这套架构里 sing-box 的运行态配置不是 Nix 直接写的——它由一个冒充 v2rayN 核心的 shim 在 GUI 拉起核心时用 jq 补丁生成。所以 rebuild 只更新了 shim 脚本,没人去重跑它;而重启 sing-box 服务更没用,它的 ExecStartPre 只做 `check`,配置合法就照旧用同一份老文件。真正的触发点是重启 v2rayN。

于是重启 v2rayN。配置确实变了,新规则确实进去了。**还是访问不了。**

这是整件事里最容易骗人的一步:你做了正确的操作,看到了预期的变化,于是默认剩下的部分也对。实际上「规则生效了」和「规则是对的」是两个独立的命题。

## 分离变量

不猜,先把「能不能通」拆成两条独立路径:

```bash
curl --noproxy '*' -o /dev/null -w '%{http_code}' -k https://<内网服务域名>/...
# 302 —— 1.09s

curl -x http://127.0.0.1:7897 -o /dev/null -w '%{http_code}' -k https://<内网服务域名>/...
# curl: (35) Recv failure: Connection reset by peer
```

不走代理正常,走代理重置。目标服务是好的,tailnet 是通的,问题 100% 在 sing-box 里面。

接着查规则顺序——sing-box 是首次匹配即生效,所以「规则存在」不代表「规则轮得到」:

```
0  sniff
1  hijack-dns
2  resolve       hosts_dns   domain_suffix: [tail.example.net, svc.example.net]
3  direct                    domain_suffix: [tail.example.net, svc.example.net]
4  direct                    ip_cidr: [100.64.0.0/10]
...
9  proxy                     (一大堆需要翻墙的域名)
```

第 3 条就命中了,轮得到,顺序没问题。直连规则完全正确地生效了。

那为什么还是重置?

## 真凶是上面那条 resolve

答案在第 2 条。那条 `resolve` 把 `svc.example.net` 整个后缀送去问 `hosts_dns`。而 `hosts_dns` 是什么?

```json
{
  "type": "hosts",
  "tag": "hosts_dns",
  "predefined": {
    "...": ["..."],
    "<tailnet-host>": ["100.64.0.2"]
  }
}
```

一张**静态表**。里面关于我这套内网的,只有一条整名映射。

`hosts` 类型的解析器只认列出的完整域名,它不做后缀匹配,也没有任何上游可以回落。于是 `<某服务>.svc.example.net` 被强行送去问一张根本没有它的表,解析返回空,连接直接重置。

我给这个域名同时做了两件事:一件对的(直连出站),一件错的(hosts 解析)。错的那件把对的那件彻底抵消了。

## 两类域名,两个解析器

想通之后,错误其实很基础:我把两种性质完全不同的域名当成一类处理了。

- **MagicDNS 名字**(`tail.example.net` 后缀):只存在于 tailnet 内部,公网 DNS 查不到。代理链里没有 Headscale 的 DNS,所以**只能**靠静态 hosts 表兜底。这是上一篇那条 `resolve` 规则的存在理由。
- **内网服务的公网入口**(`svc.example.net` 后缀):这是个货真价实的公网域名——真顶级域、公网 DNS 托管、全世界都查得到,只不过 A 记录指向一个 CGNAT 地址。

验证第二类是否真的不需要静态映射,一条命令的事:

```bash
curl -H 'accept: application/dns-json' \
  'https://dns.alidns.com/resolve?name=<内网服务域名>&type=A'
# {"name":"...","TTL":300,"type":1,"data":"100.64.0.2"}
```

配置里现成的 `direct_dns` 就能解析它。它压根不需要 hosts 表,它缺的只是一条直连出站规则——因为规则引擎没有任何理由猜到一个长得像公网域名的东西其实指向 CGNAT。

所以修复是把两个概念拆开:

```nix
# 公网查不到,只能靠静态表兜底
tailnetHosts = { "<tailnet-host>" = [ "100.64.0.2" ]; };

# 公网 DNS 就能解析,只需要强制直连出站
publicDirectSuffixes = [ "svc.example.net" ];
```

前者进 `resolve` / `hosts_dns` 路径,后者只进直连出站规则加一条指向 `direct_dns` 的 dns 规则。两条路径从此不再交叉。

## 一个还没爆的雷

拆开之后顺带看清了一件事:那条 `resolve` 规则用的是 `domain_suffix: [tail.example.net]`,但静态表里只有一台机器的整名。

也就是说,tailnet 里任何**其它**节点的 MagicDNS 名字,今天走这条路径一样会解析失败。它没爆,纯粹是因为我只访问那一台。

这是同一个错误的另一副面孔:**用后缀去匹配一张只认整名的表**。修 bug 时看到它,记下来,但没顺手改——现在没有实际影响,等真要用别的节点域名时再说。把不影响当前问题的改动塞进修复里,只会让这次的 commit 说不清自己在干什么。

## 怎么验证

代理配置很难写测试,但这次的验证链条还算完整,而且都不需要真的切系统:

1. 拿当前运行态配置直接跑一遍新的 jq 补丁,肉眼确认输出的 dns/route 规则符合预期。
2. 对补丁输出**再跑一遍补丁**,diff 应该为空——补丁必须幂等,否则每次切节点规则会叠加。
3. `sing-box check` 确认产物合法。
4. Nix 侧的 flake check 门禁。

第 2 步是这套 shim 架构特有的:补丁每次切节点都会跑,不幂等的话规则会越堆越多。

## 三句话

上一篇结尾问的三个问题,这次依然适用,但要加上第二问的下半句:

1. 失败域名最终进了哪个 outbound?
2. 进入 outbound 前,它由哪个 resolver 解析?**那个 resolver 认识它吗?**
3. 当前修复是精确匹配例外,还是改了共享默认值?

这次栽在第二问的下半句。我确认了「它被送去 hosts_dns」,却没有确认「hosts_dns 里有没有它」。一个静态表被当成了一个解析器用——它们看起来在配置里是同一个位置、同一个字段,行为却完全不同:解析器查不到会回落或报错,静态表查不到就是查不到。

再往上抽一层:**「让这个域名直连」从来不是一个操作,而是两个独立的问题**——走哪个出站,以及由谁解析。上一篇踩的是第二个问题答错(全局 resolver 太宽),这一篇踩的是把两个问题的答案绑死在了同一个域名列表里。它们碰巧对第一类域名同时成立,于是我以为它们永远该一起出现。
