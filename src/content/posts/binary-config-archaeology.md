---
title: "从二进制里挖配置：给一个没有文档的工具换掉提示音"
published: 2026-08-31
description: "herdr 的提示音又轻又和别的软件撞车。修它的过程分成三段：先分清有几个声源，再从二进制里挖出没有文档的配置面，最后用 PATH shim 补上上游没提供的能力。"
tags:
  - "NixOS"
  - "逆向"
  - "桌面通知"
  - "ffmpeg"
category: 技术实践
draft: false
---

herdr 是我用来跑多个 AI agent 的终端复用器。后台某个 agent 干完活或者要人确认时，它会响一声。这一声有两个毛病：太轻，容易漏；而且和别的软件的通知音一模一样，响了也不知道是谁在叫。

修这个问题花掉的时间里，真正写代码的部分不到五分之一。剩下的都在搞清楚「到底是谁在响」和「这个工具的配置面长什么样」。

## 先数清楚有几个声源

想改提示音的第一反应是去找配置项。这一步走错了，因为当时我还不知道响的到底是哪个程序。

先查桌面这一侧。我用的通知守护进程是 DankMaterialShell（DMS），它的设置落在 `~/.config/DankMaterialShell/settings.json`，五百多个键：

```json
"soundsEnabled": true,
"useSystemSoundTheme": false,
"soundNewNotification": true,
```

`soundNewNotification` 是全局的：任何程序发来的任何一条桌面通知，DMS 都放同一段音。这解释了「和别的软件撞车」的那一半。

再查 herdr 这一侧。它的配置由我的 NixOS 仓库渲染，当时长这样：

```toml
[ui.toast]
delivery = "system"
delay_seconds = 1
```

`delivery = "system"` 的意思是把事件发成桌面通知。所以 herdr 每次响，走的就是 DMS 那条通用音的路。

但这还不是全部。herdr 二进制里另有一套独立的声音机制，默认开着。也就是说一次事件其实响两声，一声是 herdr 自己的内置音（很轻），一声是 DMS 的通用音（比较响）。听起来像一声，是因为它们叠在一起，而且响的那一半是通用的那个。

**先数清声源，再去找配置项**。如果一开始就去调 herdr 的音量，会发现怎么调都没用，因为主要那一声根本不是它发的。

## 二进制里的配置面

herdr 没有 `herdr config default` 这类打印默认配置的子命令，官网文档也没覆盖声音这一块。但它是个 Rust 程序，两类信息在二进制里是明文：

1. serde 反序列化用的字段名。`#[derive(Deserialize)]` 会把每个结构体字段名以字符串常量的形式编进去。
2. 内置的默认配置模板。很多工具会把一份带注释的示例配置嵌进二进制，首次运行时写到磁盘。

先用 `strings` 加正则找出所有含 `sound` 的标识符：

```
SoundConfigdone_pathrequest_pathAgentSoundSettingonAgentSoundOverrides
piclaudecodexgeminicursordevinagyclineopen_codegithub_copilotdroidamphermes
```

字段名一次给全了：`SoundConfig` 有 `done_path`、`request_path`，还有一个 `AgentSoundOverrides` 支持按 agent 单独开关，覆盖的 agent 列表也在里面。

这里有个实用技巧。Rust 编译器把字符串字面量拼成连续的大块，同一个模块的常量往往紧挨着。所以不要只 grep 关键词本身，要把关键词**前后几百字节的邻域**整段 dump 出来：

```python
import re
data = open(binary, 'rb').read()
for m in re.finditer(rb'ui\.sound', data):
    s = max(0, m.start() - 300)
    print(repr(data[s:m.end() + 300]))
```

这一下捞出了完整的默认配置模板，带着作者写的注释：

```toml
# Play sounds when agents change state in background workspaces
[ui.sound]
# enabled = true
# Optional custom mp3 sound files. Relative paths are resolved from this config file's directory.
# path = "sounds/notification.mp3"
# done_path = "sounds/done.mp3"
# request_path = "sounds/request.mp3"

# Per-agent overrides: default | on | off
# By default, droid is muted.
```

同一轮还捞到两条关键的错误信息：

```
unsupported sound file format: %s = %s resolves to %s; expected an mp3
missing sound file: %s = %s resolves to %s; using default sound
```

**只认 mp3**，其他格式会被拒绝并静默退回内置音。这条约束在任何文档里都找不到，但它决定了后面所有的取舍。同一片区域还有播放器的探测链：

```
paplay  pw-play  ffplay  mpg123  mpv
```

## 提示音本身：不放二进制资产

现在知道要两个 mp3 了。从哪来？

nixpkgs 里现成的 `sound-theme-freedesktop` 是 `.oga`，格式不对。转格式要在派生里跑 ffmpeg，那还不如连音色一起自己定，顺便也就不用往仓库里塞二进制文件。

ffmpeg 的 `aevalsrc` 可以按数学表达式逐采样合成音频，`t` 是秒数：

```nix
herdrSounds = pkgs.runCommand "herdr-sounds" { nativeBuildInputs = [ pkgs.ffmpeg-headless ]; } ''
  mkdir -p $out
  synth() {
    ffmpeg -loglevel error -f lavfi -i "aevalsrc='$1':d=$2:s=48000" -ac 2 -b:a 128k "$out/$3"
  }
  synth "0.85*exp(-5*t)*sin(2*PI*784*t) + 0.85*exp(-5*(t-0.16))*sin(2*PI*1175*(t-0.16))*gt(t,0.16)" 1.1 done.mp3
  synth "0.85*exp(-16*mod(t,0.19))*sin(2*PI*1046*t)" 0.6 request.mp3
'';
```

第一条表达式是「干完了」的两声上行铃。`sin(2*PI*784*t)` 是 784 Hz 的 G5，`exp(-5*t)` 是指数衰减包络，模拟敲铃的音头和余韵。第二项是 1175 Hz 的 D6，`gt(t,0.16)` 是个 0/1 开关，让它在 160 毫秒后才出现。

第二项的相位和包络都写成 `t-0.16`，让它从自己的零时刻起振。相位从 0 开始，接缝处波形连续，不会有「啪」的爆音。这是合成里最容易踩的坑：直接用 `sin(2*PI*f*t)*gt(t,0.16)` 会在 0.16 秒处产生一个跳变，听起来就是一声破音。

第二条是「等你确认」的三连短促脉冲。`mod(t,0.19)` 把时间每 190 毫秒折回 0，同一条包络因此重复触发；衰减系数 16 比前面的 5 陡得多，所以每声都很短。重复加短促，听感上是催促。

产物实测 48 kHz、双声道、峰值 −1.8 dB 和 −4.0 dB，比内置那声响得多。

## 补上上游没提供的能力

新提示音解决了「太轻」和「分不清」，但 DMS 那一声通用音还在，一次事件仍然响两下。

DMS 是 quickshell 写的，源码就在 store 里，是明文 QML。翻 `Services/NotificationService.qml` 找到了唯一的杠杆：

```qml
const suppressSound = !!soundHints["suppress-sound"];
const requestsSound = !!soundHints["sound-name"];
if (SettingsData.soundsEnabled && (SettingsData.soundNewNotification || requestsSound) && !suppressSound) {
```

freedesktop 的 `suppress-sound` hint 表示「发送方自己会放音，你别再叠一层」。DMS 认这个 hint，而且只跳过声音，弹窗和通知中心照旧。

顺便排除了另一条路。DMS 有 `notificationRules`，看着像能按应用配规则，但它的四个 action 是 `ignore`、`mute`、`popup_only`、`no_history`，分别对应丢弃通知、去掉弹窗、去掉历史。**没有「只静音」这一档**。`mute` 这个名字有误导性，它关的是弹窗。

那就让 herdr 带上这个 hint。问题是 herdr 没有任何配置项能加 hint。它是怎么发通知的？

```
org.freedesktop.Notifications   出现 0 次
notify-send                     出现 1 次
```

它根本没走 D-Bus，是 fork 一个 `notify-send`。这反而是好事：外部命令调用是可以拦的。

```nix
notifySendShim = pkgs.writeShellScriptBin "notify-send" ''
  exec ${pkgs.libnotify}/bin/notify-send --hint=boolean:suppress-sound:true "$@"
'';

herdr = pkgs.symlinkJoin {
  name = "herdr-quiet-toast-${pkgs.herdr.version}";
  paths = [ pkgs.herdr ];
  nativeBuildInputs = [ pkgs.makeWrapper ];
  postBuild = ''
    wrapProgram $out/bin/herdr --prefix PATH : ${notifySendShim}/bin
  '';
};
```

这里只是把原包 `symlinkJoin` 出一份新派生，`pkgs.herdr` 本身没动。把它当成 overlay 会理解错作用域：overlay 会重定义 `pkgs.herdr`，全局所有引用跟着变。作用域精确到 herdr 自己 fork 出来的子进程，其他软件的通知照常响。

也不构成「钉住上游」。它没有抢跑版本，也没有打补丁等上游修，herdr 升级到下个版本这层包装照样成立。

## 这招什么时候不管用

PATH shim 拦的是「程序 fork 外部命令」这个动作。两种情况补不上：

- 目标程序用绝对路径调外部命令，比如硬编码 `/usr/bin/notify-send`。PATH 改了也没用。
- 目标程序直接走 D-Bus，不 fork 任何东西。这时只能改通知守护进程那一侧，或者给上游提 issue。

所以那句 `org.freedesktop.Notifications 出现 0 次` 是这个方案能否成立的前提。先确认目标程序真的在 fork 外部命令，再动手包装。

## 验证

`notify-send --hint=boolean:suppress-sound:true` 直接手发一条，对比不带 hint 的一条，能确认 DMS 的行为。`herdr server reload-config` 返回 `{"status":"applied","diagnostics":[]}`，空的 diagnostics 说明两个 mp3 路径都被接受了（路径错或格式错会往这里塞 `missing sound file` / `unsupported sound file format`）。

一个容易漏的坑：这个 systemd user 单元上有 `X-SwitchMethod = "keep-old"`，故意不让 rebuild 重启 server，免得连带杀掉 pane 里所有正在跑的 agent。所以 rebuild 之后单元定义指向了新二进制，跑着的进程还是旧的。配置文件那一半靠 `reload-config` 立刻生效，二进制那一半得等下次重启。这类「配置和二进制分两批生效」的情况，验证时要分开确认，不能看到 rebuild 成功就以为全都换了。
