---
title: "别被 PSR 骗了:AMD 核显笔记本 eDP 偶发方块花屏的真凶是 Panel Replay"
published: 2026-08-13
description: "一次从 blur 嫌疑一路排除到 Panel Replay 的显示花屏排查,以及内核零日志、症状三要素、轻量判别实验这几个能复用的方法。"
tags:
  - "amdgpu"
  - "AMD"
  - "Linux"
  - "Wayland"
  - "调试"
category: 技术实践
draft: false
---

一台 ThinkPad(AMD Ryzen 5 PRO 8540U,Hawk Point APU,核显 DCN 3.1.4),Wayland + niri,
偶尔花屏。不严重,但确实存在。这种"偶发、说不清、不影响用"的问题最难查,因为它既不崩溃、
也不稳定复现。下面是完整的排查过程,以及几个我觉得比结论本身更值得留下的方法。

## 先建立事实,别急着试参数

模糊症状最容易掉进的坑,是凭印象直接开始堆内核参数。正确的第一步是把"我们确定知道什么"
钉死:

- 硬件与驱动:`lspci -nnk` 认到 `HawkPoint2 [1002:1901]`,`amdgpu` 驱动,ATOM BIOS 是
  `PHXGENERIC`,DCN 3.1.4。
- 会话:Wayland + niri。
- 日志:`journalctl -k` 跨最近 8 次启动,过滤 `underflow / flip_done / PSR / dmub /
  *ERROR* / gpu reset / VM fault / VCN` 等一整串关键词。

这一步就有一个反直觉的收获:**内核 amdgpu 全程零错误、零警告**。跨 8 次启动,唯一的内核
WARNING 是一条 mac80211(WiFi)的,和显示无关。

零日志不是"没线索",零日志本身就是线索。它说明花屏不是驱动崩溃级别的事件——如果是 GPU
挂起、显示管线 underflow、GART 页错误,内核一定会喊。既然它一声不吭,问题就在**更靠输出
端的地方**:显示控制器扫描输出的通路、面板固件层,或者用户态合成器/Mesa。这一条推断直接
砍掉了后面一大半的排查空间。

## 第一个嫌疑,和一个轻量判别实验

niri 的全局 `window-rule` 开了 `background-effect { blur; noise }`。blur+noise 是每帧都跑
的 GPU shader,是当时唯一"新增的、非默认的、shader 密集的"显示层改动,嫌疑最大。

但验证它不需要 rebuild。niri 的配置由 Home Manager 物化成 `~/.config/niri/kdl/*.kdl` 的
**可写真实文件**,而 niri 支持 `niri msg action load-config-file` 热重载。于是判别实验可以
做到极轻:

```bash
# 用 KDL 的 /- slashdash 注释掉整个 background-effect 节点(一个字符,可逆)
# 然后热重载,不改仓库源、不 rebuild、不进 git、重启即自动恢复
niri msg action load-config-file
```

这里踩到一个小坑:环境里的 `NIRI_SOCKET` 指向了一个**已经死掉的旧 niri 进程**(会话中途
重启过一次),`niri msg` 直接报 "connecting to the niri socket: No such file"。解决办法是从
`/run/user/<uid>/niri.*.sock` 里挑当前活着的那个手动指定。

判别实验的价值观:**要快、要可逆、不要污染仓库**。一个还没定论的假设,不值得为它走一遍
正式的 `nixos-rebuild` + git 提交。能热重载证伪的,就别重启。

结果:关掉 blur,花屏照旧。blur 被干净地排除——而且是被"实测证伪"排除,不是被我猜掉的。

## 三个问题,把方向从五个收窄到一个

到这里嫌疑还有一堆:DPM 时钟跳变、VCN 视频解码、DCC 压缩、tearing、面板链路、ABM 背光……
每一个的缓解手段都要"改参数 → rebuild → 重启 → 用几天观察"。偶发问题的验证周期是**几天**,
盲试的代价高到离谱。

与其盲试,不如先问清症状。显示类问题有三个维度极其能收窄方向:

1. **长什么样**:彩色雪花 / 横向撕裂条 / 局部方块色块错乱 / 整屏闪烁。
2. **什么时候**:视频播放 / 画面剧烈变化 / 亮度或电源变化 / 随机静止也会。
3. **哪块屏**:只内屏 eDP / 只外接 HDMI / 两块都有。

拿到的回答是:**局部方块色块错乱 + 静止画面也会 + 只有 eDP 内屏**。这一组合几乎一次性锁死
了方向:

- 静止也会 → 排除 DPM 负载跳变、排除 VCN 视频解码。
- 只内屏、外接屏不花 → 排除 GPU 渲染核心(渲染坏的话两块屏都该坏)。
- 方块不是撕裂条 → 排除 tearing。
- 方块 = 压缩/自刷新的区块粒度;静止时仍在活动;只作用于 eDP 面板。

方向收敛到:**eDP 内屏在静止画面下的某个"按区块工作 + 省电"的显示特性**。

## 真凶:Panel Replay,以及它为什么这么难抓

联网核对时,一个和本机几乎同款硬件的案例逐字命中:Framework 笔记本(Ryzen 7840,Radeon
780M,同属 Phoenix / DCN 3.1.4)报告的是 "weird **rectangular noisy artifacting**",内屏
eDP,间歇性。他们的解法是 `amdgpu.dcdebugmask=0x400`。

而 `0x400 = DC_DISABLE_REPLAY`,禁用的是 **Panel Replay**。到这里,之前一个一直没解开的
矛盾突然通了:

> 内核日志明明打印了 `eDP-1: PSR support 0`,我据此排除了"面板自刷新类"的嫌疑——**但这
> 个排除是错的**。

关键在于:**Panel Replay 和 PSR 是两个不同的特性**。PSR(Panel Self Refresh)是老的面板
自刷新;Panel Replay 是它的后继,机制类似但按**区块**做选择性刷新。内核日志只报了 PSR 的
状态(`support 0`,确实没启用),**根本不打印 Panel Replay 的状态**。于是 Panel Replay 一
直在后台工作,却不留任何日志——这正好和前面"内核零错误"对上了:它工作在面板固件层,坏了
也不惊动内核。

症状于是全部自洽:静止画面时 Panel Replay 让面板按区块自刷新,偶发把某些区块刷成错误内容
→ 局部方块色块错乱;只作用于 eDP → 只有内屏花;省电特性专在静止画面激活 → 静止也会花。

`DC_DEBUG_MASK` 的相关位(内核 7.x 确认值),留着备查:

| 位 | 含义 |
|----|------|
| 0x2 | 禁用 stutter 内存省电 |
| 0x4 | 禁用 DSC |
| 0x8 | 禁用 clock gating |
| 0x10 | 禁用 PSR(v1 + PSR-SU) |
| 0x200 | 禁用 PSR-SU |
| 0x400 | 禁用 Panel Replay |
| 0x800 | 禁用 IPS(空闲深度省电) |

## 一条红鲱鱼:已有的 workaround 未必相关

这台机器的 `hosts/pc2/power.nix` 里早就有一行 `amdgpu.sg_display=0`,注释写着它是为了绕过
DCN 3.1.4 的 s2idle 唤醒挂起(`dcn31_program_compbuf_size` 的 REG_WAIT 超时)。

很容易顺手假设"显示问题嘛,大概和这个 sg_display 有关"。但读注释就知道,它治的是**挂起唤醒
的 hang**,和花屏是两码事。花屏在它已经设了 `=0` 的情况下照样发生。已有的 workaround 是一条
红鲱鱼,别让它带偏方向——每个 workaround 都该按它注释里写的"治什么"来对待,而不是按它"在哪
个子系统"来联想。

## 修复,以及验证的诚实边界

最终改动就是在那行旁边加一个参数:

```nix
boot.kernelParams = [
  "amdgpu.sg_display=0"
  "amdgpu.dcdebugmask=0x400"   # 禁用 Panel Replay
];
```

内核参数不能热重载,必须 `nixos-rebuild switch` + **重启**才生效(这点和前面 blur 的热重载
实验正好相反,值得注意)。重启后 `grep dcdebugmask /proc/cmdline` 确认参数进了内核。

这里要划清一条边界:我能验证的,是**配置的正确性**——`nix flake check` 通过、目标 host 的
`kernelParams` eval 出来确实包含这两个值。我不能验证的,是**花屏有没有真的消失**——那是偶发
硬件行为,只能重启后实际用几天来确认。把这两者分开说清楚,比一句含糊的"已修复"诚实得多。
如果 `0x400` 不够,下一档是 `0x800`(连 IPS 空闲省电一起禁),改一个字符再重启一次。

## 能复用的东西

- **零日志是信息,不是没线索**:驱动全程无错,基本就排除了崩溃级故障,把矛头指向显示输出
  通路或固件层。
- **症状三要素收窄显示问题**:形态 / 时机 / 哪块屏。一次结构化提问,常常抵得上好几轮盲试
  rebuild——尤其当验证周期是"几天"的时候。
- **轻量判别实验优先**:能热重载证伪的假设,就别 rebuild、别提交。快、可逆、不污染仓库。
- **别把相似的特性当成同一个**:PSR ≠ Panel Replay。日志报了前者的状态不等于排除了后者;
  很多"我以为排除了"的死角就藏在这种命名相近、机制相似、可观测性却完全不同的特性对里。
- **已有 workaround 按注释判断相关性**,别按子系统联想。

## 什么时候这套推断不成立

- 如果内核里**有** amdgpu 的 error / underflow / reset 日志,那是驱动崩溃类问题,走的是另一
  条路,本文"零日志 → 固件层"的推断不适用。
- 如果**外接屏也花**,方向就偏向 GPU 渲染核心或线路,而不是面板自刷新。
- 非 AMD、或非 Phoenix/Hawk Point 这代 APU,`dcdebugmask` 的位含义和 Panel Replay 的行为都
  可能不同,别直接套 `0x400`。

方法可以搬,具体的位和结论要按你自己的硬件和日志重新验一遍。
