---
title: "给 Wallpaper Engine 写个 Linux 选择器,和它顺手翻出来的几个坑"
published: 2026-08-31
description: "一个 37 个测试的小工具,价值不在工具本身,而在它暴露的现象与根因之间的距离,以及我三次猜错被实测纠正的过程。"
tags:
  - "Rust"
  - "Slint"
  - "NixOS"
  - "调试"
category: 技术实践
draft: false
---

## 起因

Wallpaper Engine 是 Windows 上的付费壁纸软件,`linux-wallpaperengine` 是它在 Linux 上的逆向重实现。它只接受一个创意工坊 ID,而且**只在启动时读一次**——换壁纸等于带新参数重启进程。

我的旧办法是把工坊 ID 写死在 Nix 配置里,换壁纸要改配置再 rebuild。第一版改进是十几行 shell:列出已订阅素材的标题喂给 fuzzel,选中后写状态文件、重启渲染服务。

这一版能用,但缺一样东西:**你看不到壁纸长什么样**。dmenu 的一行文字永远不会动。于是有了这个 Slint 写的选择器。

工具本身很小——一个网格、一个预览面板、三个按钮。真正值得写的是过程里翻出来的东西。

## 一、现象和根因之间可以隔很远

用了几天之后发现,video 类型的壁纸每次循环播完会卡一两秒才接上下一轮。

我的第一个假设:渲染器没让 mpv 循环,而是播完重新加载文件。查依据是它的动态库里**没有 `loop-file` 这个字符串**。

这个假设错了,而且我用两步把自己推翻:

第一步,做了个 5 秒的测试视频跑 22 秒,数解码器初始化次数——**只有 1 次**。如果每轮都重载文件,应该有四次。

第二步,翻上游源码,`GLPlayer.cpp` 里明明写着:

```cpp
mpv_set_property_string (this->m_handle, "loop", "inf");
```

`loop` 就是 `loop-file` 的别名。我只搜了字面 `loop-file`,漏掉了别名。

真正的线索在日志里一直摆着:

```
Cannot load libcuda.so.1
Using hardware decoding (vulkan-copy).
```

libmpv 是用 `dlopen` 找 libcuda 的,而 NixOS 把 NVIDIA 的库放在 `/run/opengl-driver/lib`——不在默认搜索路径里。找不到 libcuda,mpv 退到 `vulkan-copy`:每帧都要在显存和内存之间来回拷,循环回到片头时重建解码会话,那就是那一两秒。

修法是一行环境变量。同一个壁纸,只改这一个变量:

```
不设:  Using hardware decoding (vulkan-copy)   VO: 2720x1530 nv12
设了:  Using hardware decoding (nvdec)         VO: cuda[nv12]
```

卡顿消失了。

**教训不是"要设 LD_LIBRARY_PATH"**,而是:一个装在 `/etc` 里的图形驱动路径问题,表现成了"这张壁纸的循环接不上"。而我为了验证一个错误假设写的那个 5 秒测试视频,恰恰是推翻它的关键——**能测就别推理**。

## 二、我猜错的另一次:虚拟化

把列表改成自适应列数的网格时,我用了 `ScrollView` 加绝对定位,因为 Slint 的 `ListView` 只能单列。我当时告诉自己(也告诉了用户):这样会丢掉视口虚拟化,500 个格子会全部创建,是换布局付出的代价。

然后我写了条测试断言"500 个全部创建"。

它红了:**实际只创建了 15 个**。换成 2000 个格子,仍然是 15 个——和总数无关,说明 `ScrollView` 里的 repeater 同样按视口惰性实例化。那个"代价"根本不存在,我不该让用户为它做决定。

断言改成了如实的样子,并把测量结果写进注释:

```rust
// 这一条是实测来的,不是推断:2000 个格子和 500 个格子都只创建 15 个。
// 丢了不会报错,只会静静吃内存,所以拿一条测试钉住它。
assert!(created < 2000, "视口惰性实例化没生效");
```

这类"不会报错、只会静静变慢"的性质,正是最该用测试钉住的。

## 三、工具链的静默失败最贵

这个仓库有个 Stop 钩子会跑 `rustfmt`。于是我读到的文件内容和我下一次写入时的文件内容之间,隔了一次自动重排——导入被折行、函数签名被拆成多行。

后果是:我用多行字面文本做搜索替换,**匹配不上**。而匹配不上不报错,替换工具安静地什么都没做并返回成功。

我因此**两次误报了完成状态**:第一次说"实现已落盘",实际文件没变;第二次跑测试报 31 个全绿,而跑绿的是没改过的旧代码——因为没改的代码同样能编译,编译器抓不到这个。

被自己坑到第五次才养成新习惯:对已有文件只做正则或整体重写,**改完先 `grep` 新文本里的关键词,确认落盘了再相信任何构建或测试结果**。

同一类问题还有一次:我跑 `desktop-file-validate` 校验桌面项,报告说通过了。实际上那个包里没有同名可执行文件,校验器根本没启动,是管道后面的 `head` 成功让 `&&` 走了下去。后来正确跑了一次,退出码 0,那句才是真的。

**测试通过、校验通过这类结论,得先确认命令真的执行了。**

## 四、Slint 的三个具体坑

**动图不播。** Slint 至今不播动画 GIF。做法是自己解成帧序列,由一个 `Timer` 逐帧换上去。工坊素材里 52 个有 24 个自带 gif 预览,另有 20 个是 video 类型、目录里躺着真实 mp4——那 20 个直接抽 mp4 的帧,拿到的是真实动效而不是作者导出的短循环。

抽帧我用的是 **ffmpeg 命令行**,不是 Rust 绑定:

```
ffmpeg -v error -i <file> -t 4 -vf "fps=12,scale=W:H:force_original_aspect_ratio=decrease,pad=..." \
       -f rawvideo -pix_fmt rgba -
```

需要的只是"给我 N 帧 RGBA",裸视频流按固定尺寸切片就行。`ffmpeg-next` 那类绑定要链接一整条 libav,在 NixOS 上又是一轮链接麻烦。代价是多一个运行时可执行文件依赖,打包时用 wrapper 塞进 PATH。

**中文标题不要指定字体。** 这条抄的是另一个 Slint 项目的经验:硬编码的 UI 文案可以内嵌裁剪过的字体子集,但**来自外部的任意文本要刻意不设 `font-family`**,让它落到系统字体。我的壁纸标题里中日韩三种都有,内嵌任何子集都会有字变豆腐。

**无头测试要 `with_debug_info`。** `build.rs` 里不开这个,`ElementHandle::find_by_element_id` 查不到任何元素——而且不报错,看起来像界面写错了。

```rust
let debug_info = std::env::var("PROFILE").is_ok_and(|p| p == "debug");
let config = slint_build::CompilerConfiguration::new().with_debug_info(debug_info);
```

## 五、桌面集成的两件小事,各卡了一次

**`app_id` 是 null。** 合成器的窗口规则靠 app id 匹配,而 Slint 默认不设,niri 报 `app_id=null`。有了它才能给这个窗口单独关掉全局那条 `opacity 0.85` + xray 模糊——不然桌面壁纸会透过界面显出来,壁纸一动界面跟着晃,预览图的颜色也不再是它自己的。

`slint::set_xdg_app_id()` 的调用位置有个陷阱:文档说"必须在窗口显示之前",但**不能在窗口创建之前**——Slint 的平台是创建第一个组件时才初始化的,更早调用返回 `NoPlatform`,窗口根本起不来。

**启动器搜不到。** 装好之后命令能跑,但 fuzzel 里搜不到。原因不是构建失败:包里只有 `bin/`,没有 `share/applications/*.desktop`。启动器列的是桌面项,不是 PATH 上的可执行文件。

## 六、Nix 打包:两样链接器记不住的东西

```nix
wrapProgram $out/bin/wallpaper-picker \
  --prefix PATH : ${lib.makeBinPath [ ffmpeg ]} \
  --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath runtimeLibs}
```

ffmpeg 要在 PATH 上(抽帧靠跑它);那些被 `dlopen` 的库(wayland、libxkbcommon、libGL、fontconfig)**不出现在 ELF 依赖里**,`autoPatchelf` 也就补不上 runpath。

顺带一个实测结论:**Nix 构建的产物基本不可移植**。ELF 解释器写死在 `/nix/store/...glibc-2.42-84/lib/ld-linux-x86-64.so.2`,普通发行版上那个路径不存在,下载了直接起不来;闭包 1003 MiB、288 个 store 路径。想让别人免编译,正确机制是二进制缓存,不是往 release 挂二进制。

**协议也不是自由选择。** Slint 是三重授权 `GPL-3.0-only OR Royalty-free-2.0 OR Software-3.0`,开源项目走 GPL 那条最干净。而且它给的是 `only` 而不是 `or-later`——跟着写 `only` 才诚实,`or-later` 等于承诺一个我们无权授予的版本。

## 七、以屏幕为准,而不是以配置文件为准

界面上"当前壁纸"那个标记,最初读的是状态文件。但状态文件说的是"下次启动该画哪张",渲染器只在启动时读一次。于是退订了正在渲染的那张、或者别的程序改了状态文件而渲染器还没重启时,标记和屏幕就是两回事。

改成从 `/proc` 读渲染进程自己的命令行,渲染器没在跑时才退回状态文件:

```rust
let observed = rendering_id().or_else(|| library.current_id().ok());
```

取命令行里最后一个"够长的纯数字"作为壁纸 ID——工坊 ID 有九到十位,而 `--fps 30` 只有两位,长度就能区分。这条守卫我做了变异验证:把长度门槛从 6 位放宽到 1 位,那条测试立刻变红,说明它不是空断言。

库变动的检测同理。原先只比对 id 集合,于是作者原地推新版本(id 不变、标题和预览图换了)界面察觉不到。改成比对"id + 目录与 project.json 两者较晚的修改时间"。用轮询而不是 inotify:两秒一次 readdir 比引一个监听依赖划算,而且 Steam 下载途中目录是半成品状态会发一串中间事件,轮询天然把它们合并成一次。

实测:启动时 52 个壁纸,在 Wallpaper Engine 里订阅一个、再造一个测试素材,状态行到 54,**全程没重启选择器**;删掉测试素材后回到 53。

## 八、顺手确认了"壁纸有 bug"不是幻觉

用的过程中觉得不少 scene 类型壁纸效果不对——不会动,或者缺了该动的部分。查渲染器日志,40 分钟内四类抱怨:

| 次数 | 日志 | 后果 |
|---|---|---|
| 60 | `CText: no usable system font found` | 带文字的图层一个字都不画 |
| 7 | `VolumeLight objects are not supported yet` | 体积光缺失 |
| 3 | `Unsupported puppet model header MDLV0013` | puppet 骨骼动画不支持——鱼、头发、布料那些"会动的部分" |
| 多条 | `Unknown object type found: {... "script": "use strict..."}` | 靠内置 JS 脚本驱动的图层被整个丢掉 |

Wallpaper Engine 的 scene 格式是闭源私有的,逆向重实现只覆盖了一部分。我特意验证了字体那条**不是环境问题**:在 systemd 用户服务环境里 `fc-match sans` 正常返回,渲染器也确实链接了 fontconfig——是它自己的字体选择逻辑没找到可用字体。

这个发现反过来影响了界面设计:给格子加了种类标签,`VIDEO` 绿底(纯 mp4,渲染必然正确)、`SCENE` 灰底(可能缺特性),再加一个"只看 video"的过滤。库里 52 个素材,31 个 scene、20 个 video、1 个 web。

也顺带解释了为什么预览面板有价值:工坊自带的 gif 显示的是壁纸**本该**什么样,桌面上是渲染器**实际能画出**什么样,两者的差距正是这些未实现的特性。

## 不适用的地方

- 整个方案绑在 `linux-wallpaperengine` 和 Steam 的目录布局上,不是通用壁纸工具。
- libcuda 那条只对 NVIDIA + 把驱动库放在非标准路径的发行版成立。
- 工坊在线搜索和订阅我验证过技术可行(`steamworks` crate 调 ISteamUGC,关键词"荔枝"一次命中 50 条,预览图 URL 也拿得到),但最后没做——非必需,而且以 431960 初始化 SDK 会让 Steam 好友列表显示"正在玩 Wallpaper Engine"。结论和实测数据记在仓库的 ADR 里,将来要捡起来不用重新趟一遍。

代码:[yebei199/wallpaper-picker](https://github.com/yebei199/wallpaper-picker),GPL-3.0-only,37 个测试(33 个逻辑 + 4 个无头界面)。
