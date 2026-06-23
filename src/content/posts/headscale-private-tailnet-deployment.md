---
title: "用 Headscale 搭一个私有 tailnet 后踩到的坑"
published: 2026-06-23
description: "一次 Headscale、Tailscale 客户端和 Headplane 的真实部署复盘：入口、端口、节点注册和 API 校验。"
tags:
  - "Headscale"
  - "Tailscale"
  - "自托管"
  - "运维"
category: 技术实践
draft: false
---

这次目标很简单：把几台服务器、本机和后续可能加入的移动设备放进同一个私有 tailnet。客户端继续用成熟的 Tailscale，控制面换成自托管的 Headscale。这样不需要手写 WireGuard peer，也能保留 NAT 穿透、点对点连接、subnet router、exit node 这些能力。

最后方案跑通了，但中间的坑不在 WireGuard 本身，而在几个很容易被低估的边界上：公网入口到底给谁、Headscale 本身是不是也要作为节点加入、Headplane 为什么拿着正确 API key 仍然登录失败，以及这些手工排查结果怎么沉淀回部署脚本。

## 控制面只需要公网入口，数据面不该误解成“都走服务器”

Headscale 在这个方案里是协调服务器，不是数据转发服务器。它负责节点注册、密钥、机器列表、DNS 和 ACL 等控制信息。真正的数据面还是 Tailscale 客户端之间的 WireGuard 连接。

这决定了两个端口的角色完全不同：

- `443/tcp` 是 Headscale 控制面入口，客户端注册和控制协议要用它。
- `41641/udp` 是 Tailscale 客户端直连数据面常用端口，开放它主要是提高直连概率、降低走 DERP 中继的机会。

所以“都走同一个服务器吗”这个问题的答案是否定的。Headscale 不应该成为所有流量的中心转发点。机器之间能直连就直连，不能直连时才走 DERP。开放 `41641/udp` 不是让 Headscale 转发更多流量，而是让当前这台机器作为 tailnet 节点时更容易和其他节点直接打洞。

## 443 入口要明确交给 Headscale

这台 VPS 上原本还有 k3s 和 Traefik 的公网入口规划，但 Headscale 的控制协议不适合直接藏在普通 Cloudflare Proxy 或 Tunnel 后面。最终选择很直接：把公网 `443/tcp` 交给 Headscale，Traefik 的公网入口挪开。

这个决定要写进部署系统，而不是靠操作当天记忆：

```text
ops service deploy headscale --yes
```

部署流程负责同步 compose 配置、确保 DNS 是 DNS-only、开放必要防火墙规则、启动 Headscale，并跑健康检查。这样下次部署不是“照着聊天记录手工点端口”，而是同一条命令重复执行。

这里还有一个容易忽略的点：如果 VPS 控制台防火墙一开始没有开放公网端口，部署本身可以把远端服务拉起来，但外部客户端仍然连不上。服务器内服务健康和公网可达是两件事，排查时要分开看。

## VPS 宿主机也应该是 tailnet 节点

一开始容易只把 Headscale 当成控制面容器，忽略宿主机本身也需要加入 tailnet。实际使用时，很多管理入口、tailnet-only 面板和宿主机服务都需要通过这台 VPS 的 tailnet 地址访问。

最终部署流程里补了这一步：

- 确保宿主机安装并启动 `tailscaled`。
- 临时生成一次性 preauth key。
- 用私有 Headscale login server 注册宿主机。
- 设置稳定 hostname。
- 用 `tailscale status --json` 断言状态为 Running，并确认宿主机拿到了 tailnet IP。

这里没有把 preauth key 长期写进 `.env`。注册 key 是一次性引导材料，不是长期配置。真正应该写进仓库的是“怎么生成和消费它”的部署逻辑。

## Headplane 只能放在 tailnet 内

Headplane 是管理界面，不需要公开到公网。最终做法是让它只绑定宿主机的 tailnet 地址和一个管理端口，浏览器访问时必须先在 tailnet 里。

这带来了一个实际问题：本机浏览器如果走了 v2rayN 或类似代理，可能不会使用系统 DNS，也可能不认识 tailnet DNS。系统里 `tailscale status`、终端里 `curl` 能通，不代表浏览器一定能打开。浏览器路径如果经过代理，就要让代理的 DNS/hosts 也知道这个 tailnet 名称。

这类问题不应该靠猜。后来把 DNS 检查和浏览器访问分别验证：终端能 `curl` 说明 tailnet 服务本身在；浏览器打不开时再看代理 DNS 和代理规则。

## 正确的 API key 也可能登录失败

这次最有价值的故障是 Headplane 登录失败。现象是：按提示生成了 Headscale API key，Headscale 里也能列出这把 key，但 Headplane 页面仍然提示 API key 校验失败。

只看现象很容易误判成 key 复制错了。实际根因是 Headplane 访问 Headscale API 的 URL 写错了。

Headscale 开了 TLS，证书主机名也绑定在控制面域名上；但 Headplane 之前用的是容器网络里的明文 HTTP 地址。结果它在校验 API key 前，先拿 Headscale OpenAPI spec 就失败了，日志里能看到 400。

修复不是重新生成 key，而是让 Headplane 用 HTTPS 和匹配证书主机名的地址访问 Headscale API。同时在 Docker compose 里给 Headscale 服务加同名 network alias，让容器内访问不必绕公网，又能通过 TLS 主机名校验。

这条修复最后还加了回归测试：Headplane 配置不能再退回明文 HTTP，compose 里也必须保留对应 alias。否则下次换机器部署，很可能又在登录页看到同一个“key 错了”的假象。

## 诊断命令也应该进 ops

这次排查 Headplane 时临时需要两类信息：

- Headscale 当前有哪些 API key。
- Headplane 容器最近的日志。

如果每次都临时 SSH 再手工敲 Docker 命令，很快就会变成不可复现操作。最后把它收成只读命令：

```text
ops service headplane-debug --yes
```

它不修改远端，只读 key 列表和 Headplane 日志。这个命令很小，但价值在于把“登录页报错时第一步看什么”固定下来。下一次不是凭记忆排查，而是先跑同一个诊断入口。

## 验证不要只停在容器健康

这次完成后做了几层验证：

- `headscale health` 通过。
- 宿主机 Tailscale 节点状态为 Running。
- Headplane tailnet-only 页面能打开。
- 只读诊断里旧的 OpenAPI 400 错误消失。
- 浏览器实际使用同一把 API key 登录成功，并跳到机器列表页。
- 本地测试覆盖 Headplane API URL 和 compose alias。

这些验证覆盖了不同层次：容器活着、控制面可用、宿主机入网、管理界面可达、API key 能校验。只做其中一项都不够，因为这次的问题恰好发生在“服务看起来活着，但 UI 调 Headscale API 失败”的夹层里。

## 这次沉淀下来的结论

第一，Headscale 是控制面，不是所有流量的数据面。不要把 `41641/udp` 理解成 Headscale 中继端口，它是提高节点直连概率的 Tailscale 数据面端口。

第二，公网 `443/tcp` 的归属要明确。Headscale 控制协议、证书签发和代理兼容性会影响整体设计，不适合部署当天临时决定。

第三，宿主机是否加入 tailnet 是一个产品需求，不是附属步骤。只要还想通过 tailnet 管理 VPS 上的服务，宿主机就应该作为节点注册。

第四，浏览器打不开 tailnet 服务时，不要只看系统 DNS。代理客户端可能接管了浏览器 DNS 路径，终端和浏览器要分别验证。

第五，API key 校验失败不一定是 key 错。先看服务端日志和 API endpoint，尤其是 TLS、Host、证书主机名和容器网络 alias。

第六，手工修过的部署问题必须回到仓库。配置、测试和 `ops` 命令都写进去之后，下一台机器才不会重复踩同一个坑。

这次部署最终不是“装了一个 Headscale”这么简单。真正完成的是一条可重复的私有 tailnet 控制面路径：控制面入口、宿主机节点注册、tailnet-only 管理界面、故障诊断和回归测试都被收进仓库。后面再加手机、更多服务器、subnet router 或 exit node，基础面就稳得多。
