---
title: "NixOS 模块的类型化选项在替你推导 systemd 依赖，绕过它就得自己补回来"
published: 2026-08-17
description: "同一个 caddy 配置写成 useACMEHost 还是手写证书路径，生成的 Caddyfile 一模一样，但只有前者会给 caddy.service 加上 After=acme-*.service。"
tags:
  - "NixOS"
  - "Caddy"
  - "systemd"
  - "模块设计"
category: 技术实践
draft: false
---

一次 `nixos-rebuild switch` 之后 caddy 起不来：

```
Status: "loading new config: ... loading certificates:
         open /var/lib/acme/<host>/cert.pem: no such file or directory"
```

日志时间戳把答案摆在脸上：

```
16:31:55  caddy 启动 → 读不到 cert.pem → exit 1
16:31:56  acme-<host>.service 才铺下自签占位证书
```

差一秒。这是首次签发那趟 rebuild 才会撞上的竞态：ACME 模块会先放一张自签占位证书让依赖它的
服务能起来，但 caddy 没有等它。

## 同样的配置，两种写法

出问题的写法是手写证书路径：

```nix
services.caddy.virtualHosts.${host}.extraConfig = ''
  tls /var/lib/acme/${host}/cert.pem /var/lib/acme/${host}/key.pem
  reverse_proxy 127.0.0.1:8088
'';
```

正确的写法是用 `useACMEHost`：

```nix
services.caddy.virtualHosts.${host} = {
  useACMEHost = host;
  extraConfig = "reverse_proxy 127.0.0.1:8088";
};
```

**两者生成的 Caddyfile 完全一样** —— 模块看到 `useACMEHost` 就自动拼出同一行 `tls`
指令，路径都不差一个字符。差别在生成的 systemd unit 上。翻 nixpkgs 的 caddy 模块：

```nix
acmeEnabledVhosts = filter (hostOpts: hostOpts.useACMEHost != null) virtualHosts;
vhostCertNames    = unique (map (hostOpts: hostOpts.useACMEHost) acmeEnabledVhosts);
...
systemd.services.caddy = {
  wants = map (certName: "acme-${certName}.service") vhostCertNames;
  after = map (certName: "acme-${certName}.service") vhostCertNames;
};
```

手写路径时 `vhostCertNames` 是空列表，`after` 和 `wants` 就都是空的 —— 验证一下：

```
$ systemctl show caddy.service -p After
After=network.target
```

模块没有解析 `extraConfig` 里那行 `tls` 的字符串去猜你依赖哪张证书，也不应该解析。它只认自己
定义的那个有类型的选项。

## 这不是 caddy 模块的特例

`vhostCertNames` 在同一个模块里还驱动了另一样东西：

```nix
assertions = ... ++ map (name: mkCertOwnershipAssertion {
  cert = certs.${name};
  groups = config.users.groups;
  services = [ config.systemd.services.caddy ];
}) vhostCertNames;
```

这条断言在 eval 期检查 caddy 的用户组读不读得到证书目录，读不到直接 build 失败。也就是说
`useACMEHost` 这一个选项承载了两样推导出来的副作用：**启动顺序**和**权限检查**。用等价的
低层写法绕过它，两样一起丢，而且丢得悄无声息 —— 配置文件长得一模一样，`nix flake check` 也过。

## 第二次踩，这次是知情的

后来需要让 caddy 监听一段端口范围（`:13000-14999` 这种）。Caddyfile 表达不了：站点地址里写
端口段直接报 `invalid port`，写在 `bind` 指令里则被静默丢弃只保留第一个端口。只有 JSON 配置的
`listen` 数组支持端口段。

于是必须从 `services.caddy.virtualHosts` 换到 `services.caddy.settings`。翻模块：

```nix
configFile =
  if cfg.settings != { } then
    settingsFormat.generate "caddy.json" cfg.settings
  else
    <Caddyfile 那一大坨>;
```

`settings` 一非空，`virtualHosts` 整条路径就没人读了 —— 连带 `vhostCertNames`、`after`、
断言，全部归零。**同一个 bug 会原样复发。**

`settings` 的类型是 `attrsOf anything`，模块拿到的是一坨任意结构的 JSON，没办法知道里面哪个
字符串是证书路径、属于哪张证书。这不是模块偷懒，是类型信息在这里确实不存在了。

所以只能手写回来，并且把「删掉会怎样」写进注释：

```nix
# 这两条以前是 caddy 模块从 virtualHosts.*.useACMEHost 推出来的。settings 是自由
# JSON，模块看不懂里面哪个字符串是证书路径，推不出依赖，只能手写。
# 删掉它们的后果不是报错而是一次竞态：acme 首次签发那趟 rebuild 里 caddy 会抢在
# 自签占位证书落盘之前启动，读不到 cert.pem 退出 1，然后再也不起来。
systemd.services.caddy = {
  after = [ "acme-${fqdn}.service" ];
  wants = [ "acme-${fqdn}.service" ];
};
```

那条 `mkCertOwnershipAssertion` 补不回来（它是 assertion，不是配置），但这个模块本来就显式设了
`security.acme.certs.<fqdn>.group = config.services.caddy.group`，构造上是对的 —— 这一点同样
写进注释，否则下次有人改动时不知道少了一层保护。

## 可复用的判断方法

**在用低层写法替换一个类型化选项之前，先去模块源码里 grep 这个选项名，看它被谁读了。**

```bash
grep -n "useACMEHost" $(nix eval --raw nixpkgs#path)/nixos/modules/services/web-servers/caddy/default.nix
```

如果它只出现在生成配置文件的地方，替换是安全的。如果它还出现在 `systemd.services`、
`assertions`、`users.groups`、`security.*` 里，那些都是你要自己补的。

几个经验性的判断：

- **生成的文件一样 ≠ 等价。** NixOS 模块的选项经常同时驱动配置文件、systemd 单元、用户组、
  目录权限、断言。只对比生成的配置文件会漏掉后面几样。
- **换到自由形状的配置（`attrsOf anything`、`configFile`、原始文件路径）时，默认假设所有推导
  都失效**，然后一项项确认。这类选项的文档通常不会列出「你会因此失去什么」。
- **补回来的依赖必须带注释说明删掉的后果。** 从「模块帮你管」变成「注释里记着别删」是一次真实的
  健壮性下降，起码要让下一个读者知道这行不是装饰。
- **这类 bug 只在特定时序下出现。** 证书已经存在的机器上，怎么 rebuild 都不会报错；只有首次签发
  那一趟才撞得上。测试环境和生产环境的差别可能就是「有没有那个文件」。

## 什么时候不该绕过

这次绕过是有正当理由的：Caddyfile 在语法层面就表达不了端口段，不存在「用类型化选项也能做到」的
选项。如果只是因为「手写更直接」「不想查文档」而绕过，那就纯粹是拿健壮性换几分钟 —— 这次那行
手写的 `tls` 路径，和 `useACMEHost` 相比一个字符的便利都没省下。
