---
title: "DNS 全被劫持的网络里，怎么把 DNS-01 证书签下来"
published: 2026-08-17
description: "lego 的传播自检永远等不到 TXT，因为它问的是一个把首次 NXDOMAIN 负缓存了 1800 秒的劫持缓存；用一条不可路由地址证明劫持，再用固定等待绕开自检。"
tags:
  - "ACME"
  - "DNS"
  - "NixOS"
  - "网络排查"
category: 技术实践
draft: false
---

给内网机器签 Let's Encrypt 证书，走 DNS-01 是标准做法：机器在 CGNAT 后面，公网进不来，
但 LE 只查 DNS 不连机器。配好 Cloudflare 的 API token，`nixos-rebuild` 一跑，卡了两分钟，
然后失败：

```
propagation: time limit exceeded: last error: authoritative nameservers:
NS <ns>.ns.cloudflare.com.:53 did not return the expected TXT record
[fqdn: _acme-challenge.<host>.tail.example.net.]
```

## 先把不是问题的排除掉

这个报错的字面意思是「权威服务器没返回期望的 TXT」，最容易的解释是记录没建上。但日志上面
一行写着：

```
[INFO] cloudflare: new record for <host>.tail.example.net, ID 9a0b86cc...
```

记录建成功了，还返回了 ID。于是逐个排除：

- token：`GET /user/tokens/verify` 返回 `active`
- zone：token 能看到的 zone 只有一个，`status: active`，`name_servers` 和公网 `dig NS` 查到的完全一致
- 委派：子域没有单独的 NS 记录，`dig NS sub.example.net` 回的是父域的 SOA，说明 TXT 应该由父域的权威服务器提供
- 记录落点：zone 里的 DNS 记录列表也对得上

全都是对的。那问题只可能在「谁在回答这个查询」。

## 一条不可路由的地址就够了

直接问权威服务器：

```
$ dig +time=5 +tries=1 @<cloudflare-ns-ip> SOA example.net
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1
example.net.  1779  IN  SOA  ...
```

两个地方不对劲：

1. **没有 `aa` 标志，却有 `ra`**。权威服务器的应答必须置 `aa`（authoritative answer），
   而且不该宣称自己提供递归。这两条都反了，说明回答的不是权威服务器。
2. **TTL 是 1779 而不是 1800**。权威服务器每次都返回配置的完整 TTL；只有缓存才会递减。

到这一步已经八九不离十，但还能做一个决定性的实验 —— 拿一个**保证不可路由**的地址当 DNS
服务器：

```
$ dig +time=4 +tries=1 @192.0.2.1 SOA example.net
;; flags: qr rd ra
example.net.  1725  IN  SOA  ...
```

`192.0.2.1` 是 RFC 5737 的 TEST-NET-1，公网上不存在任何主机。它「回答」了，而且 TTL 和刚才那次
连续递减 —— 说明这台机器发出去的**每一个目的端口 53 的包，无论目标 IP 是什么，都被同一个缓存
解析器接管了**。UDP 和 TCP 都一样。

这个测试的好处是不需要任何权限、不依赖对网络拓扑的了解，一条命令给出是非题的答案。

## 机理

链条是这样的：

1. lego 创建 TXT 记录，Cloudflare 侧成功
2. lego 立刻开始传播自检，查 `_acme-challenge.<host>`
3. 这个查询被劫持到本地缓存。记录刚建，缓存还没有，向上游查到的是 **NXDOMAIN**
4. NXDOMAIN 按 zone SOA 的 minimum 字段做**负缓存**。这个 zone 是 **1800 秒**
5. 之后每 2 秒一次的轮询全部命中负缓存，返回 NXDOMAIN
6. lego 的传播超时是 **120 秒**，远小于 1800 秒，必然超时

负缓存 TTL 比自检超时长一个数量级，这个组合下自检**不可能**成功，重试多少次都一样。

顺带一提，`dnsResolver = "1.1.1.1:53"` 这类配置在这里完全是空的 —— 包根本到不了 1.1.1.1。
它在配置里看起来像是「已经处理了 DNS 问题」，实际什么也没做，反而更容易误导排查。

## 修法：不自检，改固定等待

关键认知是：**传播自检是给客户端自己看的，不是协议要求的**。真正验证 TXT 的是 Let's Encrypt，
它从自己的网络查，完全不经过这层劫持。自检只是为了避免过早通知 CA 导致验证失败。

所以把自检换成一段固定等待：

```nix
security.acme.certs.<fqdn> = {
  dnsProvider = "cloudflare";
  extraLegoFlags = [ "--dns.propagation-wait=60s" ];
};
```

lego 的三个相关 flag 语义不一样，选错了效果差很远：

| flag | 行为 |
|---|---|
| `--dns.propagation-disable-ans` | 只跳过「权威服务器」那一项检查 |
| `--dns.propagation-rns` | 改用递归服务器检查（在这个场景下同样被劫持） |
| `--dns.propagation-wait <d>` | **禁用全部检查**，改成固定等待 `d` |

NixOS 有个现成的 `dnsPropagationCheck = false`，但它映射到的是第一个
（`--dns.propagation-disable-ans`），效果是零等待直接通知 CA。Cloudflare 通常几秒内生效，
零等待多半也能成，但没有余量。用 `extraLegoFlags` 显式给 60 秒更稳，代价是每次签发/续期多等
一分钟 —— 一年两次，无所谓。

改完之后实测：

```
16:51:22  开始
16:51:28  cloudflare: new record ...
16:52:36  Finished   ← 74 秒，日志里 "Waiting for DNS record propagation" 出现 0 次
```

证书签下来了，`openssl s_client` 验证 issuer 是 Let's Encrypt，不是占位的自签。

## 边界

- **只对 DNS-01 有效。** HTTP-01 靠 CA 反向连接，不受本地 DNS 劫持影响（但 CGNAT 后面本来就用不了）。
- **前提是劫持缓存的其他行为正常。** lego 还要用解析器做 apex 域判定和 CNAME 解析，这些查的是
  普通公网名字，劫持缓存能正确回答，所以没受影响。如果连这些都答错，就得先解决劫持本身。
- **这是绕过，不是修复。** 根因在网络设备上，不在这台机器。哪天路径干净了，把这行 flag 删掉
  就能恢复自检 —— 所以值得在注释里写清楚为什么加它，否则下一个人只会看到一行没来由的等待。

## 可复用的部分

排查 DNS 时，`dig @<不可路由地址>` 值得作为一个常备动作。它把「我的 DNS 查询到底去了哪里」
这个模糊问题变成是非题，而且不需要任何前置知识。同类信号还有两个，都在 `dig` 的默认输出里：

- 应答有 `ra` 而无 `aa`：回答者不是权威服务器
- 连续两次查询 TTL 递减：中间有缓存

另一条更一般的：**当某个配置项「看起来处理了问题」但问题依旧时，先验证这个配置项是否真的在
起作用**，而不是继续在它下游找原因。这里的 `dnsResolver` 就是典型 —— 它写得完全正确，只是
它管的那段路径已经被接管了。
