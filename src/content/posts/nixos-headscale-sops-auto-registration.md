---
title: "NixOS 多机接入自建 Headscale:用 sops 管理 preauth key 实现装机自动入网"
published: 2026-08-13
description: "把 Headscale 的 preauth key 加密进 NixOS 配置仓库,新装机器首次开机自动入网;顺带讲清 rebuild 到底会不会消耗 key,以及重装后为什么旧节点还占着名字。"
tags:
  - NixOS
  - Headscale
  - Tailscale
  - sops-nix
category: 技术实践
draft: false
---

## 背景

我有几台 NixOS 机器,通过自建的 Headscale 组成私有 tailnet,互相之间用 MagicDNS 域名免密 SSH。此前的接入流程是纯手动的:每次装一台新机器,先 SSH 到跑 Headscale 的 VPS 上签一把一次性 preauth key,再回到新机器上跑 `tailscale up --login-server ... --authkey ...`。流程本身不复杂,但重装系统的那天往往要同时处理十件事,这种"必须去另一台机器上拿一个临时凭证"的步骤最容易卡住节奏。

配置仓库里已经用 sops-nix 管理了 SSH 私钥和若干服务凭证,那么把 preauth key 也加密进去,让新机器首次开机自动注册,不会引入新的信任根:解密靠的还是那把随身携带的 age 私钥。

## 方案

nixpkgs 的 `services.tailscale` 模块原生支持这条路,核心只有几行:

```nix
{ config, ... }:
{
  sops.secrets.headscale_authkey.sopsFile = ../../secrets/headscale.yaml;

  services.tailscale = {
    enable = true;
    useRoutingFeatures = "client";
    openFirewall = true;
    authKeyFile = config.sops.secrets.headscale_authkey.path;
    extraUpFlags = [ "--login-server=https://headscale.example.com" ];
  };
}
```

`authKeyFile` 一旦非 null,模块会生成一个 `tailscaled-autoconnect.service`,开机时自动完成注册。官方文档只演示了 Tailscale SaaS 的用法,对接 Headscale 的差别就是 `extraUpFlags` 里那行 `--login-server`。

`--hostname` 不需要传,tailscale 默认取系统 hostname。secret 用默认属主(root, 0400)即可,autoconnect 单元以 root 运行。

一个容易踩的坑:模块还有个 `authKeyParameters` 选项(`ephemeral`/`preauthorized`/`baseURL`),那是给 Tailscale SaaS 的 OAuth 客户端用的,模块会把 `?ephemeral=true` 这样的查询串直接拼在 key 后面,Headscale 不认这个格式。对接 Headscale 时别碰它。

## rebuild 会不会消耗 key

这是我落地前最大的顾虑,也是搜索引擎上最难找到明确答案的问题:如果每次 `nixos-rebuild switch` 都重新注册一次,一次性 key 立刻烧掉,reusable key 也会在 Headscale 里刷出一堆重复节点。

答案是不会,证据在模块源码里。`tailscaled-autoconnect` 的脚本是个状态机,循环读取 `tailscale status --json` 的 `BackendState`:

- `NeedsLogin` / `NeedsMachineAuth` / `Stopped`:发一次 `tailscale up --auth-key ...`
- `Running`:`systemd-notify --ready` 然后退出

已入网的机器状态是 `Running`,脚本第一次检查就直接退出,`tailscale up` 根本不执行,key 不会被读取。我在一台已注册的机器上 rebuild 后的 journal 可以佐证:

```
systemd[1]: Starting tailscaled-autoconnect.service...
tailscaled-autoconnect-start[...]: Tailscale is running
systemd[1]: tailscaled-autoconnect.service: Deactivated successfully.
```

三行日志,从启动到退出,没有发起任何注册。所以 key 只在真正的"注册事件"时被消费:全新装机、`/var/lib/tailscale` 丢失、手动 `tailscale logout`。日常 rebuild 和重启都是空跑。

这个单元还带来一个副产品:它是系统里"已入网"的时序锚点。要跑绑定 tailnet IP 的服务,`after = [ "tailscaled-autoconnect.service" ]` 就能等到网络就绪。

## 一次性还是 reusable

preauth key 签发时有两个正交的参数,语义容易混:

- `--reusable`:有效期内不限使用次数。默认是一次性,用一次就作废。
- `--expiration`:这张票放多久作废。**只挡新注册,不影响已入网的节点**。机器注册成功那一刻起,身份就是自己的 node key,preauth key 的使命已经结束。默认值只有 1 小时,不显式给的话签出来的 key 基本等于一次性。

我最终选了一次性 key 配超长有效期(Headscale 没有"永不过期"选项,用 `--expiration 876000h` 约 100 年顶替)。理由是注册事件本身很稀有,一年也就一两次重装,每次用掉后补签一把的成本是两条命令:

```bash
headscale preauthkeys create --user <user> --expiration 876000h
sops set secrets/headscale.yaml '["headscale_authkey"]' '"<key>"'
```

换来的是更小的泄露暴露面:一次性 key 泄露最多放一个新节点进来,而且在 `headscale nodes list` 里看得见、删得掉;reusable key 泄露则是一张长期有效的入场券。如果嫌补签麻烦,`--reusable` 加长有效期也完全成立,这纯粹是风险偏好问题。

两条命令写进了模块头部的注释里。这类"下次用到已经是一年后"的操作,文档写在别处必然找不到,写在消费它的代码旁边才活得下来。

## 重装后旧节点为什么还占着名字

自动化只覆盖"入网"这半边,另外半边 Headscale 帮不了你:节点身份。

Headscale 的身份模型是 node key,也就是 `/var/lib/tailscale/tailscaled.state` 里那把私钥,和主机名无关。重装系统清掉了 state,新系统生成全新的 node key,Headscale 眼里这就是一台从没见过的机器。而旧节点记录对应的私钥已经随旧系统消失,那行记录变成永远离线的僵尸,但它仍然占着 given name:新机器注册进来会被改名成 `<name>-1` 之类,MagicDNS 的旧域名继续指向那台永远连不上的僵尸。

Headscale 没有"把已有节点改绑到新 key"的机制,`rename`/`expire` 都只动元数据。所以重装后必须在服务端手动处理一次:

```bash
headscale nodes list
headscale nodes delete -i <旧节点id>
```

删掉旧行,名字才会重新指向新机器。如果配置里(SSH config、其他机器的 known_hosts 预置等)写死了 MagicDNS 域名,这一步不做,整个舰队都会连错方向。

唯一能把这一步也省掉的路,是重装前备份 `tailscaled.state`、装完恢复回去:node key 不变,Headscale 认得,连注册都不需要。我没有走这条路,原因有两个。state 文件是节点身份私钥,泄露等于别人能冒充这个节点且完全不可见,而 preauth key 泄露只是多一个看得见的新节点。它还是个运行时活文件,仓库里的副本会逐渐过期,真到重装那天可能恰好失效,你信任的备份在唯一需要它的时刻不工作。

## 失效模式

方案落地后要知道它怎么坏:

- **key 已被用掉或过期**:下一台新装机开机后静默停在 `Logged out`,没有任何显式报错。诊断入口是 `journalctl -u tailscaled-autoconnect`,会看到 `tailscale up` 被拒。
- **age 私钥没到位**:sops 解不开 secret,autoconnect 读不到文件,表现和上一条相同,靠 journal 区分。新装机的引导顺序里,age 私钥永远是第一步,它同时也是登录密码 hash 等其他 secret 的前提。
- **`tailscale up` 的 prefs 语义**:`up` 会把没显式给出的偏好恢复默认。autoconnect 只在 `NeedsLogin` 时执行,那时 state 本来是空的,所以无害;但如果日后用 `tailscale set` 手调过什么,要落到模块的 `extraSetFlags` 里,否则某次重装后静默丢失。

## 适用边界

这套做法的前提是配置仓库已经有一套可信的 secret 管理(sops-nix、agenix 之类),且 age/PGP 私钥的分发问题已经解决。如果仓库里本来没有任何加密凭证,为这一个 key 引入整套 sops 不划算,手动签 key 的流程反而更简单。用 Tailscale SaaS 的用户也有更好的选择:官方的 OAuth client 配 `authKeyParameters` 走的就是为此设计的路径。
