---
title: "为什么 JetBrains 的 direnv 插件救不了你:环境注入的时机问题"
published: 2026-07-08
description: "在 NixOS + Niri 上让 RustRover 自动加载 direnv,靠的不是插件,而是搞清楚环境要在 exec 之前还是之后注入。"
tags:
  - "NixOS"
  - "direnv"
  - "JetBrains"
  - "Niri"
category: 技术实践
draft: false
---

## 一个看似简单的诉求

我的 Slint(Rust)项目用 `.envrc` + nix-direnv 管理工具链:

```bash
# .envrc
use nix slint.nix
```

在 fish 终端里一切正常——fish 配了 direnv hook,`cd` 进目录就自动加载,`cargo`、rust-analyzer 都能找到 alsa、wayland、openssl 这些原生依赖。

但从 Niri 的应用启动器(`Mod+W` → fuzzel)点开 RustRover,IDE 就是个"裸"进程,拿不到 slint 工具链。我原来的土办法是:

```bash
pkill -f RustRover
cd ~/RustroverProjects/slint_study
direnv exec . rust-rover . &
```

杀掉、进目录、`direnv exec` 重启。能用,但每次都手动,烦。

我第一反应也和大多数人一样:**装个 JetBrains 的 Direnv 插件不就行了?** 装了。**不生效。** 这篇就是记录我怎么定位到"为什么插件根本救不了这个场景",以及最终怎么解决的。

## 先证伪几个直觉

### 直觉一:是 PATH 问题吧?

从图形会话启动的进程,PATH 常常和登录 shell 不一样,direnv/nix 可能不在里面。查了一下:

```bash
cat /proc/$(pgrep -x niri)/environ | tr '\0' '\n' | grep '^PATH='
```

结果 PATH 里 `/etc/profiles/per-user/yb/bin`(direnv 所在)和 `/run/current-system/sw/bin`(nix 所在)都在。**PATH 没问题**,插件调 `direnv`/`nix` 是能找到的。排除。

### 直觉二:插件其实在工作?

我去看正在运行的 RustRover 进程环境,发现它**居然带着** slint 的 `PKG_CONFIG_PATH`:

```bash
cat /proc/<rustrover-pid>/environ | tr '\0' '\n' | grep PKG_CONFIG_PATH
# 指向 alsa-lib / wayland / openssl 的 nix store 路径
```

差点被这个误导成"插件部分生效了"。但它的命令行是纯 `rust-rover`、cwd 是 `/home/yb`(fuzzel 启动的特征),不该有这个变量。于是查会话本身:

```bash
cat /proc/$(pgrep -x niri)/environ | tr '\0' '\n' | grep PKG_CONFIG_PATH
# 有!
```

**这是全局泄漏**——我在 `hosts/reusable/development.nix` 里给整个会话设了 `PKG_CONFIG_PATH`,导致每个 GUI 程序都看得到。和插件毫无关系,是个障眼法。

### 关键证据:启动那一刻,环境是空的

真正一锤定音的检查,是数进程启动时到底有几个 nix-shell 标记:

```bash
cat /proc/<rustrover-pid>/environ | tr '\0' '\n' \
  | grep -cE '^(IN_NIX_SHELL|CC|CXX|LD_LIBRARY_PATH|NIX_CFLAGS|AR|LD)='
# 输出:0
```

fuzzel 启动的 RustRover,**启动时 nix-shell 关键变量命中 0 个**。而用 `direnv exec` 跑同一个目录:

```bash
cd ~/RustroverProjects/slint_study
direnv exec . env | grep -cE '^(IN_NIX_SHELL|CC|CXX|LD_LIBRARY_PATH|NIX_CFLAGS|AR|LD)='
# 输出:6
```

差别就在这里。

## 根因:环境注入的时机

这里有个必须记住的事实:

> `/proc/<pid>/environ` 反映的是**进程启动那一刻**的环境,进程启动后由 JVM 内部 `setenv` 改的变量,它**不会**更新。

而 JetBrains 的 Direnv 插件正是这么工作的——它在 **JVM 启动之后、项目打开时**才跑 `direnv export`,把变量通过运行时注入。问题是:

- 它注入到的地方,只有**内置终端**和**Run/Debug 配置**;
- 它**够不到** rust-analyzer——那是 Rust 插件另起的外部分析进程,用的是 IDE 启动时捕获的原始环境;
- 也够不到原生工具链探测和链接器。

所以你会看到一个很拧巴的现象:内置终端里 `cargo build` 可能是好的,但编辑器里满屏飘红,因为做代码分析的 rust-analyzer 根本没拿到 `PKG_CONFIG_PATH` / `LD_LIBRARY_PATH`。

对比 `direnv exec . rust-rover .`:环境在 `exec` **之前**就设好了,JVM 和它 fork 出来的**所有**子进程(rust-analyzer、cargo、linker)统统继承。

**这不是插件配置错了,是插件模型的结构性天花板。** 一句话:

> `exec` 之前设环境,覆盖整棵进程树;启动之后再塞,只能覆盖你手动管理的那几个入口。

对 Rust/C++ 这种吃原生工具链、且靠外部 LSP 进程做分析的 IDE,插件天生做不到 `direnv exec` 做的事。想清楚这一点,方向就只剩一个:**在启动前就把环境带上**。

## 解决:包一层启动器

既然要"启动前带环境",那就把手动那条命令固化成 wrapper。缺的那块拼图是:**fuzzel 启动时不知道要开哪个项目,而 direnv 是按目录加载的。**

答案藏在 JetBrains 自己的配置里。`recentProjects.xml` 有一个 `lastOpenedProject`,而 RustRover 默认"启动重开上次项目"——两者天然对齐:

```xml
<option name="lastOpenedProject" value="$USER_HOME$/RustroverProjects/slint_study" />
```

wrapper 逻辑就三步:读它 → 换掉 `$USER_HOME$` 前缀 → `direnv exec` 拉起。用 Nix 的 `writeShellScript` 生成,再用 `xdg.desktopEntries` 从 `XDG_DATA_HOME` shadow 掉上游的 `.desktop`(XDG 优先级最高,fuzzel 里图标不变、行为自动切):

```nix
mkDirenvLauncher = { pkg, bin, configPrefix }:
  let
    dirVer = lib.versions.majorMinor pkg.version;
    recent = "${config.home.homeDirectory}/.config/JetBrains/${configPrefix}${dirVer}/options/recentProjects.xml";
  in
  pkgs.writeShellScript "${bin}-direnv" ''
    set -eu
    real="${pkg}/bin/${bin}"
    recent="${recent}"
    proj=""
    if [ -f "$recent" ]; then
      raw=$(${pkgs.gnused}/bin/sed -n 's/.*name="lastOpenedProject" value="\([^"]*\)".*/\1/p' "$recent" | head -n1)
      prefix='$USER_HOME$'
      case "$raw" in
        "$prefix"*) proj="$HOME''${raw#"$prefix"}" ;;
        *) proj="$raw" ;;
      esac
    fi
    if [ -n "$proj" ] && [ -d "$proj" ]; then
      cd "$proj"
      exec ${pkgs.direnv}/bin/direnv exec "$proj" "$real" "$@"
    fi
    exec "$real" "$@"
  '';
```

几个踩过的坑:

- **别用 bash 参数展开去替换 `$USER_HOME$`**。`${raw/$USER_HOME$/...}` 里的 `$USER_HOME` 会被当变量展开成空。要用 `case` + `${raw#"$prefix"}`(带引号,取字面前缀)才安全。
- **Nix 缩进字符串里的转义**:bash 的 `${...}` 要写成 `''${...}`,`$USER_HOME$`、`$HOME`、`$(...)` 这些没有 `${` 的会原样透传,不用转义。生成出来一定要 `cat` 出真实脚本核对一遍。
- **direnv 用哪一个**:直接引 `${pkgs.direnv}/bin/direnv`,不依赖 PATH。它照样会读 home-manager 写的 `direnvrc`(nix-direnv 的 `use nix` 就靠它),因为 dev shell 缓存在磁盘上,`direnv exec` 直接命中缓存。

三个 IDE(RustRover / WebStorm / PyCharm)用一个列表驱动即可,bin 名、config 目录前缀、desktop id 各不相同,列清楚:

```nix
jetbrainsIDEs = [
  { pkg = pkgs.jetbrains.rust-rover; bin = "rust-rover"; configPrefix = "RustRover"; desktopId = "rust-rover"; ... }
  { pkg = pkgs.jetbrains.webstorm;   bin = "webstorm";   configPrefix = "WebStorm";  desktopId = "webstorm";   ... }
  { pkg = pycharm;                   bin = "pycharm";    configPrefix = "PyCharm";   desktopId = "pycharm";    ... }
];
```

对没有 `.envrc` 的项目(比如很多前端/Python 项目),`direnv exec` 在无 `.envrc` 的目录里是**无害 no-op**,等价于普通启动。所以给全部 IDE 套上是安全的,哪天某个项目加了 `.envrc` 自动生效,不用再改配置。

## 怎么验证(不用真开 GUI)

配置改动的验证不需要真的把 IDE 点开:

1. **求值不炸**:`nix eval .#nixosConfigurations.<host>.config.system.build.toplevel.drvPath`。
2. **生成物正确**:把 `writeShellScript` 的产物 `cat` 出来,核对 `real=`、`recent=`、`direnv` 路径。重构后我特意确认 rust-rover 的 launcher 路径**逐字节没变**(store hash 一致),证明模板转义没被改坏。
3. **环境真注入**:复刻 wrapper 最后那步,把 `rust-rover` 换成 `env` 来观察:

   ```bash
   cd "$proj" && direnv exec "$proj" env | grep -cE '^(IN_NIX_SHELL|CC|LD_LIBRARY_PATH|NIX_CFLAGS)='
   # >=3 就说明工具链已经进去了
   ```

这三步覆盖了"能不能构建 / 生成对不对 / 效果有没有",比手动开 IDE 肉眼看飘红靠谱得多,也快得多。

## 边界与遗留

- **同一实例里切换到别的项目**,环境不会跟着换——wrapper 只在启动时读一次 `lastOpenedProject`。但这条限制和手动 `direnv exec` 完全一样,没有变差。日常守着一个项目来回开碰不到。
- 前面那个全局 `PKG_CONFIG_PATH` 泄漏是另一个独立问题:它让每个 GUI 程序都看到某个项目的 pkgconfig,挺脏的,值得单独收拾。

## 可复用的结论

1. **诊断进程环境,认准 `/proc/<pid>/environ`,并且要意识到它只反映启动时刻。** 数关键变量命中数,比肉眼扫一串更能定性。
2. **区分"env-before-exec"和"env-after-start"。** 凡是靠外部子进程干活的工具(LSP、编译器、链接器),运行时注入基本救不了,必须在启动前把环境备好。这条不止适用于 JetBrains,任何"插件在进程内改环境"的方案都有同样的天花板。
3. **别被泄漏的环境变量带偏。** 一个"看起来插件在工作"的变量,可能只是别处全局设的。判断插件有没有生效,要看**它该注入的那批**变量在**该到的进程**里齐不齐。
4. **Nix 里包启动器,`writeShellScript` + `xdg.desktopEntries` shadow 掉上游 `.desktop`** 是个干净的套路:图标、名字不变,行为透明替换,还能一个列表驱动多个同类程序。
