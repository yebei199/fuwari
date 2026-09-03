---
title: "Home Manager 独立安装还是挂在 NixOS 模块里：sudo 不是判断标准"
published: 2026-09-03
description: "独立 Home Manager 不需要 sudo，听起来很诱人，但在单人 NixOS 机器上它换来的是第二份 nixpkgs、第二套 overlay 和第二条回滚线。"
tags:
  - NixOS
  - Home Manager
  - Nix Flakes
category: 技术实践
draft: false
---

Home Manager 有两种接法。一种是独立安装，自己跑 `home-manager switch`；另一种是作为 NixOS 模块，
跟着 `nixos-rebuild switch` 一起生效。网上讨论这两者时，最常被拿出来的区别是「独立安装不用 sudo」。
这条没错，但它不是决定用哪种的理由。这篇记录我在自己的 NixOS 配置仓库里把这个问题想清楚的过程。

## 先把权限这件事说准

独立 Home Manager 全程以你自己的身份运行。它只往你的用户 profile 和家目录里写东西。真正需要 root 的
只有 Nix daemon，而 daemon 本来就在后台以 root 跑着，你通过 socket 请求它构建，不是你自己提权。

NixOS 模块方式需要 root，但原因不在 Home Manager 那部分。`nixos-rebuild switch` 要写
`/nix/var/nix/profiles/system`、重启系统级 systemd 单元，这一步绕不过去。Home Manager 自己的激活
仍然是以用户身份跑的：它通过 `home-manager-<user>.service` 执行，`systemctl --user` 和家目录写入
都以普通用户完成。所以「模块方式会用 root 去动我的用户级单元」这个担心不成立。

还有一个中间地带很多人忽略了：构建不需要 root，激活才需要。

```bash
nixos-rebuild build --flake .#<host>
```

这条命令无 sudo 就能跑完，确认整份配置能编译过。如果只想看 Home Manager 那部分的产物，
可以直接构建它的 activation package：

```bash
nix build .#nixosConfigurations.<host>.config.home-manager.users.<user>.home.activationPackage
```

这个属性路径我在自己的 flake 上求值过，能拿到 `home-manager-generation` 这个 derivation。
所以「想省 sudo」这个需求，模块方式同样能满足，只是要把「构建」和「激活」分开看。

## 独立安装真正多出来的东西

把 sudo 这条划掉以后，再看两种方式的差异，天平就很明显了。

**第二份 nixpkgs 实例。** 模块方式下打开 `home-manager.useGlobalPkgs = true`，Home Manager 直接复用
系统的 `pkgs`，系统级 overlay 自动对用户环境生效。独立安装会实例化自己的一份 nixpkgs，overlay
要重复接一遍，版本也可能和系统漂移。两个 flake.lock 意味着两次 `nix flake update`，以及两处可能
不一致的地方。

**第二条回滚线。** 系统 generation 回滚会把 Home Manager 那部分一起带回去。独立安装有自己的
profile，出问题时要各回各的，还得记住两边哪个 generation 是配套的。

**跨层配置的中间态。** 桌面环境这类东西天然是跨层的：窗口管理器的系统侧服务和用户侧配置、输入法的
系统包和用户环境变量、sops 密钥的系统解密和用户读取，都要成对改。拆成两次 switch 就会有一个
窗口期，系统侧已经是新的而用户侧还是旧的。仓库里的断言脚本按整台机器一起跑，也默认了这两层
是同一次变更。

**已经在付的成本。** 既然每次改配置都要跑一次 `nixos-rebuild switch`，Home Manager 附带在里面
并不多敲一次 sudo。反过来，独立安装省掉的那一次 sudo，换来的是上面三条每天要维护的东西。

## 什么时候独立安装才是对的

这个结论有明确的适用边界，换一种场景就会反过来：

- 机器不是 NixOS，比如其他 Linux 发行版或 macOS，根本没有 NixOS 模块可挂。
- 你没有 root，只能管自己的家目录。
- 多个人共用一台机器，各自维护各自的用户环境，不希望一个人的改动触发整机 switch。
- 你想高频迭代 dotfiles，不想每次都评估整个系统配置。

我的三台机器都是单人使用的 NixOS，一条都不沾，所以保持模块方式不动。

## 一句话版本

选 Home Manager 的接法，看的不是「要不要 sudo」，而是「你有几份 nixpkgs、几条回滚线、几次 switch」。
单人 NixOS 机器上，这三个数都应该是一。
