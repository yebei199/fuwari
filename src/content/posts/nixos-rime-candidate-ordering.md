---
title: "「按 d 永远出『动』」:一个 Rime 排序 bug,和三个不是词库的锅"
published: 2026-07-08
description: "小鹤双拼里高频字排不到第一,第一反应是换词库。但数据证明词库没问题——真凶是用户词典漂移、被砍的语法模型,和 nix store 的 1970 时间戳。"
tags:
  - "NixOS"
  - "Rime"
  - "fcitx5"
  - "输入法"
  - "调试"
category: 技术实践
draft: false
---

## 症状:一个高频字排不到第一

小鹤双拼,输入法候选窗口里按一个 `d`,弹出来的是:

```
1. 动   2. 的   3. 都   4. 到   5. 到   6. 时   7. 等   8. 得
```

「动」永远第一,「的」屈居第二。对一个整天打「的」的人来说,这排序很反直觉。我的第一反应和大多数人一样:**当前词库有问题,换个更好的方案吧**——雾凇拼音?万象拼音?

结论先摆这:**换词库是错的**。这篇记录我怎么用数据把「换词库」这个直觉证伪,然后揪出三个真正的原因,以及其中两个是 NixOS 独有的坑。

## 证伪直觉:词库根本没错

在下手迁移之前,先看一眼词库里这俩字到底什么权重。薄荷方案(oh-my-rime)的 `rime_mint.chars.dict.yaml`:

```
的	de	48288412
动	dòng	38035
```

**「的」的静态词频是「动」的约 1270 倍。** 而且两者编码完全不同:小鹤里「的」是 `de`(d+e),「动」是 `ds`(d+ong→s)。纯静态排序下,「的」必然在「动」前面。

所以「动」能排第一,**只可能不是词库的锅**。换词库解决不了这个症状——这个证伪省下了一次几百兆词库的无谓迁移。真凶另有其人,而且恰好有三个。

## 真凶一:用户词典把自己养歪了

Rime 默认开着 `enable_user_dict`——你选得多的词,它自适应调频往前提。这本是好功能,但也意味着:**如果你历史上频繁上屏过「动」类词,用户词典会把「动」的动态词频顶到盖过「的」的静态词频。**

查 `rime_mint.userdb/` 的 `.log` 时间戳,一直在活跃写入。也就是说,用户想要的「随打字自动优化」,本身就是当前这个 bug 的成因。

修法很朴素——备份并清空被污染的用户词典,让它在健康基线上重新学:

```bash
cd ~/.local/share/fcitx5/rime
mv rime_mint.userdb{,.bak-$(date +%s)}
```

清空后,「的」凭 1270 倍的词频立刻回到第一。这一步单独就解决了截图里的字面问题。

> 教训:当「自适应」系统给出反直觉结果时,先怀疑它的历史状态被污染了,而不是它的静态数据错了。

## 真凶二:语法模型被「砍」了——但不是谁砍的

用户还有第二个诉求:**希望候选能随上下文实时重排**。这对应的是 Rime 的**语法模型**(octagram / n-gram),它作用于已上屏的中文词序列,按上下文给候选打分重排。

诡异的是:薄荷方案明明是拿万象基础词库合成的,却没有语法模型。是谁砍的?查了上游仓库才发现——**谁都没砍,是压根没装上**:

1. 薄荷的 flypy 方案默认就没开 `contextual_suggestions`(上游 schema 里查无此项)。
2. `.gram` 模型文件被上游 `.gitignore` 掉了(`*.gram`),**根本不在 git 源码树里**。
3. 薄荷是在打包 CI(`.cnb.yml`)里现下载模型:去 `amzxyz/RIME-LMDG` 的 LTS release 抓 `.gram` 打进成品包。

把这三条串起来,NixOS 用户就踩坑了:我的 flake 用 `oh-my-rime = { flake = false; }` **直接拉 GitHub 源码树**,而模型被 gitignore 排除在源码树外——所以拿到的是「没模型的半成品」。薄荷官方分发的成品是带模型的,但那份「带」发生在 CI,不在 git 里。

这是个通用教训:**当上游用「构建期下载」而非「提交进仓库」来分发大文件时,任何基于源码树的消费方式(flake=false、submodule、tarball)都会漏掉它。** 你得去读它的 CI 脚本,才知道成品里多了什么。

### librime 这边,反而不用操心

原本我以为要给 librime 打 octagram 插件、写 overlay 重编 fcitx5-rime——这是我预判的最大集成风险。结果读 nixpkgs 源码发现,`librime` 的默认 `plugins` 早就带上了:

```nix
plugins ? [
  librime-lua
  librime-octagram
],
```

也就是说**语法模型支持早就编进你现在的 fcitx5-rime 了**,系统层一行都不用改。省事。

于是修法是:用 `pkgs.fetchurl` 拉薄荷 CI 用的同一个 LTS 模型,symlink 进 rime 目录,再在 schema 里把开关打开:

```nix
# rime.nix
grammarModel = pkgs.fetchurl {
  url = "https://github.com/amzxyz/RIME-LMDG/releases/download/LTS/wanxiang-lts-zh-hans.gram";
  hash = "sha256-...";  # nix store prefetch-file 拿
};
# ...
"${rimeDir}/wanxiang-lts-zh-hans.gram".source = grammarModel;
```

```yaml
# double_pinyin_flypy.schema.yaml
translator:
  contextual_suggestions: true
grammar:
  language: wanxiang-lts-zh-hans   # 对应 .gram 文件名去后缀
```

本质就是在声明式配置里,把薄荷 CI 那步手动复刻出来。(代价:这个 LTS 模型 420MB,会进 nix store。)

## 真凶三:rebuild 了,但啥都没变——1970 年的时间戳

改完 nix、`nixos-rebuild switch` 成功,用户回来说:**还是「动」第一,没变。**

查现场,证据链很清楚:

- 用户词典没重置(没有 `.bak`)。
- 根目录 `.gram` 软链有了(rebuild 时间戳),但 `build/` 里没有编译产物。
- `build/double_pinyin_flypy.schema.yaml` **停留在前一天**——Rime 还在跑旧方案。

原因是:**Rime 跑的是编译缓存 `build/`,只在显式「部署」时重编。** rebuild 只换了源文件软链,没碰 Rime 的运行状态。

那 Rime 不是会检测「源文件比 build 新就自动重编」吗?这里有个 NixOS 独有的暗坑:**nix store 里所有文件的 mtime 都被归一化成了 1970-01-01。** 于是 Rime 一比时间戳,永远觉得源文件「更旧」,自动重编这条路根本不通——**在 NixOS 上,Rime 必须显式部署,没有例外。**

叠加第二层原因:`nixos-rebuild switch` 以 root 跑,而 fcitx5 活在你的用户 Wayland 会话里,root 没法干净地戳它。

### 让 nix 自己触发部署——第一版,越修越糟

手动去托盘点「重新部署」太烦。既然 fcitx5 是 systemd 用户服务,第一反应就是用 `home.activation` 钩子在切换时「清缓存 + 重启」:

```nix
# ⚠️ 这是反面教材,别抄
$DRY_RUN_CMD rm -rf "$HOME/${rimeDir}/build"          # 删掉编译缓存,逼 Rime 重来
systemctl --user restart app-org.fcitx.Fcitx5@autostart.service
```

装上、rebuild,当场好了。然后每次 rebuild——**哪怕跟输入法八竿子打不着的改动——rime 都退回「未部署」状态,又得手动 deploy。** 比不加钩子还烦。

### 为什么 `rm -rf build` 是个坑

拿 `rime_deployer` 实测一次冷部署(空 `build/`),真相就出来了:

```
Elapsed (wall clock): 0:10.56       # 冷全量重编要 10 秒
Maximum resident set: ~900 MB
```

而且**部署日志里没有一行提到语法模型**——`.gram` 是运行时才 mmap 的,编译阶段根本不碰。

把因果串起来:`rm -rf build` 把 77MB 已编译表全删了,fcitx5 一重启就得在后台跑这 10 秒冷重编;这期间输入法处于半残状态,而那次重编还常被别的 Lua 报错打断,停在半成品——直到你手动「重新部署」才补全。**换句话说:rebuild 前 `build/` 只是「过期但完整可用」,我这一删,把它变成了「每次归零、且重建不可靠」。删缓存不是刚需,是自伤。**

### 第二版:确定性重编,别赌自愈

正确姿势是:**别删 `build/` 赌 fcitx5 自己重编,而是在重启前用 `rime_deployer --build` 把 `build/` 确定性地编好**,再重载 fcitx5;并用一个 marker 记录输入的 store 路径,只在 rime 配置真变了时才跑,避免每次无关 rebuild 都吃这几秒。

```nix
home.activation.rimeRedeploy = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
  export XDG_RUNTIME_DIR="''${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  rd="$HOME/${rimeDir}"
  marker="$rd/build/.hm-rime-inputs"
  # 输入变了才重部署:oh-my-rime / 语法模型 / 本地 schema 与 default 的 store 路径
  want="${ohMyRime} ${grammarModel} ${./rime/double_pinyin_flypy.schema.yaml} ..."
  if [ "$(cat "$marker" 2>/dev/null)" != "$want" ]; then
    if $DRY_RUN_CMD ${pkgs.librime}/bin/rime_deployer --build "$rd" "$rd" "$rd/build"; then
      echo "$want" > "$marker"
      fcitx5Unit="app-org.fcitx.Fcitx5@autostart.service"
      if ${pkgs.systemd}/bin/systemctl --user is-active --quiet "$fcitx5Unit" 2>/dev/null; then
        $DRY_RUN_CMD ${pkgs.systemd}/bin/systemctl --user restart "$fcitx5Unit" || true
      fi
    fi
  fi
'';
```

三个要点:

- **确定性构建,不赌自愈**。`rime_deployer --build` 在重启前就把完整 `build/` 编好,fcitx5 起来直接用,没有「半残窗口」。
- **marker 门控**。用输入文件的 store 路径当指纹,内容一变路径就变;无关 rebuild 指纹不变,直接跳过,不吃那几秒。
- **重启用 `is-active` 守卫**。TTY / headless 切换时 `systemctl --user` 连不到用户总线,守卫让它安静跳过,不报错、不阻断 rebuild。

> 关键认知:`nixos-rebuild switch` 里的 home-manager 激活是**以用户身份**跑的(通过 `home-manager-<user>.service`),所以 `systemctl --user` 和写用户目录都成立——这也是为什么重启这步真能生效。

## 花絮:候选字右边括号里的字母是啥

顺带一个用户的疑问:候选里 `动(el)`、`的(bu)` 括号里的字母是什么?

不是拼音(「的」的双拼是 `de`,却显示 `bu`)。那是**辅助码**——小鹤音形的形码,由方案里的 `auxCode_filter@flypy_full` 生成并显示在注释里。作用是同音字里补码直选、免翻页:打 `d` 出一堆同音字,想直接要「动」,补它的辅助码 `el` 就一步到位。显示出来是为了让你顺便记住形码。嫌碍眼,去掉那个 filter 即可。

## 可复用的结论

- **反直觉的排序,先证伪最贵的假设。** 花五分钟 grep 词频,就否掉了「换整套词库」这个几百兆的弯路。
- **「自适应」功能出锅时,先查它的历史状态被没被污染**,而不是先怀疑静态数据。
- **上游用「构建期下载」分发大文件时,基于源码树的消费方式会静默漏掉它**——读它的 CI,别只读它的仓库。
- **NixOS 上但凡有「编译缓存 + 时间戳判新」的程序(Rime 是一个),1970 mtime 会让它永不自动刷新**。但别急着 `rm -rf` 缓存——那会把「过期但可用」变成「归零且重建不可靠」。正解是调它的**确定性构建入口**(Rime 是 `rime_deployer --build`)在切换时一次编好,再用 marker 门控只在输入变化时跑。
- **第一个「当场好了」的自动化,未必是对的**。`rm -rf build` 装上当场生效,却在每次无关 rebuild 时暗地里自伤;是 `rime_deployer` 的 10 秒实测数字戳穿了它。自动化也要证伪,不能只看「这次好了」。
- 系统层集成前先读 nixpkgs 源码:我以为要重编 librime,结果 octagram 早就内置了。**预判的风险,一半是没读源码吓自己。**
