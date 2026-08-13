---
title: "rebuild 成功却 command not found:一次 NixOS 上 Claude Code 自删循环的排查"
published: 2026-08-13
description: "从『rebuild 成功但 cc 还是旧的』一路查到 musl 加载器缺失与 bun 重装空转,并连根修掉 net-refresh 的自删循环。"
tags:
  - "NixOS"
  - "nix-ld"
  - "Claude Code"
  - "bun"
  - "调试"
category: 技术实践
draft: false
---

## 症状:两个自相矛盾的事实

一次 `nixos-rebuild switch` 干净收尾,末尾照例甩出一句:

```
systemctl --user start --no-block net-refresh.service
```

然后问题来了:rebuild 明明成功,命令行里的 `claude`(下称 cc)却还是旧的。再敲一次,直接变成:

```
claude: command not found
~/.config/fish/functions/claude.fish (line 32):
        command claude $argv
```

一个东西刚"构建成功",紧接着"根本不存在"——这两个事实必须同时解释,只解释一个都是自欺。

## 第一层:成功的不是它

关键在于 cc 压根不是 Nix 构建出来的。它由一个后台服务 `net-refresh.service` 用 `bun add -g @anthropic-ai/claude-code@latest` 安装。而 rebuild 结尾那句是 `--no-block`——点火即走的异步后台任务。所以:

- rebuild 报 success ≠ claude 更新完成,后者还在后台 `bun add`;
- 就算装完,当前正在运行的 claude 进程仍是旧二进制,得重开。

这解释了"还是旧的"。但解释不了"command not found"——装,不至于把它装没了。于是往下挖。

## 第二层:一个删了又装不回来的死循环

翻 journal,`net-refresh` 的 claudeCli 步骤反复失败,而且每轮都留下同一串:

```
claude: platform package drift: expected 2.1.229, got 2.1.202
claude: repairing install after version drift detected
net-refresh: step claudeCli failed
```

对照磁盘上的包版本:

```
claude-code            (meta)  -> 2.1.229
claude-code-linux-x64  (glibc) -> 2.1.202
claude-code-linux-x64-musl     -> 2.1.229
```

配置里的校验逻辑要求"glibc 平台包版本 == meta 版本"。`2.1.202 ≠ 2.1.229`,于是每轮判"漂移"、触发 repair;repair 先 `rm -rf` 包目录、`rm -f ~/.bun/bin/claude`,再重装。删是删了,重装却没成——`~/.bun/bin/claude` 就此消失。这才是 command not found 的直接原因:不是"还没装完",是"每轮把自己删了又装不回来"。

但为什么装不回来?这里踩到两个更深的坑。

## 坑一:musl 二进制在 NixOS 上根本跑不起来

我一度以为救急很简单:手动 `bun add @latest` 让它自己的 postinstall 重建 bin 即可。装完却发现 `~/.bun/bin/claude` 还是没有,而 `@anthropic-ai` 目录里只剩下一个 303MB 的 musl 独立二进制。直接执行它:

```
$ .../claude-code-linux-x64-musl/claude --version
no such file or directory
```

文件明明在,`ls` 看得见,执行却报 "no such file or directory"。这是一个经典误导:**ENOENT 报的不是那个二进制,而是它 ELF 头里写死的加载器(interpreter)。**

```
$ readelf -l .../claude-code-linux-x64-musl/claude | grep interpreter
      [Requesting program interpreter: /lib/ld-musl-x86_64.so.1]
```

musl 二进制要 `/lib/ld-musl-x86_64.so.1`。而 NixOS 上没有这个文件——`nix-ld` 只搭了 glibc 那座桥:

```
/lib64/ld-linux-x86-64.so.2 -> .../nix-ld -> glibc 的 ld-linux
```

没有任何东西提供 musl 加载器。所以在这台机器上,能跑的永远是 **glibc 变体** `claude-code-linux-x64`(它的 interpreter 是 `/lib64/ld-linux-x86-64.so.2`,经 nix-ld 落到 glibc)。这也解释了上游为什么会出现"meta 到 2.1.229、glibc 只到 2.1.202"这种错位——他们在把 Linux x64 往 musl 迁,glibc 构建的节奏慢了半拍。对 NixOS 而言,那个更新的 musl 包是死重量,更旧的 glibc 包才是唯一能用的。

> 可复用结论:在 NixOS 上执行一个下载来的动态二进制,报 "no such file or directory" 而文件确实存在时,先 `readelf -l <bin> | grep interpreter` 看它要哪个加载器,再确认那个路径存不存在。八成是外来二进制的加载器 nix-ld 没提供。工具同时给 glibc 和 musl 构建时,选 glibc。

## 坑二:`rm` + `bun add` 是"只删不装"的空操作

搞清该用 glibc 后,还有一个问题:配置里的 repair 已经是"`rm -rf` 后重装"了,为什么修不好?

因为 `~/.bun/install/global/package.json` 里仍然写着 `claude-code` 和 `claude-code-linux-x64` "已安装"。`bun add` 一看锁文件已满足,只打了一句 "Resolving dependencies" 就以为万事大吉,**不会把刚被 `rm -rf` 掉的目录重新解包**。于是 repair 变成了纯破坏:删的生效了,装的被跳过了,命令还照样退出 0。

验证也顺手证明了修法:改用 `bun add ... --force` 强制重新解析并解包,三个包立刻回到位,`~/.bun/bin/claude` 重新链到 glibc 二进制,`claude --version` 输出 2.1.229。

> 可复用结论:一段"先删后重建"的修复,如果重建那步依赖锁文件/缓存、而它们仍记录着"东西还在",那这段修复就是个静默空操作——东西被删干净,重建被跳过,退出码还是 0。凡是重建紧跟一次手动删除,要么强制重新解析(`--force`),要么先把条目从清单里移掉。

## 连根修

三个 bug 叠在一起,对应三处改动(都在 `claude.nix` 的 `claudeCli` 步骤):

1. **不再手动按 meta 版本号锁平台包。** 平台包和 meta 各走各的版本节奏(glibc 根本没有 `@2.1.229` 之外的那些 meta 版本号),硬装只会失败并留下旧包。改成只装 meta 包,平台二进制交回它自己的 `optionalDependencies` + postinstall 去挑选并链接——在 NixOS 上它会正确落到 glibc 变体。
2. **校验不再比对版本相等。** NixOS 上能跑的永远是 glibc 构建,而上游可能给某个 meta 钉一个更旧的 glibc,版本相等本就不可能成立。改成只问一件事:`claude --version` 能不能真跑出版本号。跑得起来即健康。
3. **repair 带 `--force`。** 这样删掉的目录会被真正重新解包,而不是被"锁文件已满足"跳过。

删掉的代码(平台名映射、版本相等校验、meta 版本锁)比新增的多:`44 insertions(+), 67 deletions(-)`。同步更新了对应测试(把断言从旧的坏逻辑改成守护新不变量 + 回归防护)和两处 README。门禁 `nixfmt --check` / `nix flake check` / `tests/*.sh` 全绿。

## 一个操作细节:修完别急着重启服务

修复落进仓库,不等于部署到机器上。`net-refresh.service` 的 unit 是 Home Manager 生成的,里面编着旧逻辑的 store 路径——**要等下一次 rebuild 才会重新生成**。在那之前手动 `systemctl --user start net-refresh.service`,跑的还是旧逻辑,会把刚救活的 claude 再删一次。正确顺序是:提交 → rebuild(激活时自动用新逻辑重跑一次)→ 完成。

## 什么时候这套结论不适用

- **不用 nix-ld、而是走 FHS/buildFHSEnv 或 patchelf 打过补丁的环境**:加载器的来源不同,"ENOENT = 缺 interpreter"的判断仍成立,但"只有 glibc 能跑"的结论要按你实际提供了哪些加载器重新判断。
- **真正静态链接的 musl 二进制**(没有 interpreter 段):它在哪都能跑,和本文的动态 musl 二进制是两码事;别一看到 musl 就以为 NixOS 跑不了。
- **别的包管理器**:"删后重装是空操作"的具体触发条件取决于它信不信任锁文件。npm/pnpm/cargo 各有各的缓存语义,`--force` 的写法也不同,结论是同一个,开关不是。

一句话收束:一个"构建成功却 command not found"的矛盾,逼着把三件事同时讲清楚——异步安装、外来二进制的加载器、包管理器的重装语义。只解释其中一件,都会得到一个能通过自己那点测试、却是错的"修复"。
