---
title: "从壁纸卡顿查到每帧 5.2 KB 的泄漏"
published: 2026-09-09
description: "一次动态壁纸排查：卡顿的真凶是渲染器自己的帧率上限，而把帧率提上去之后，一个每帧泄漏的老问题跟着翻倍暴露出来。"
tags:
  - "NixOS"
  - "性能排查"
  - "内存泄漏"
  - "mpv"
  - "heaptrack"
category: 技术实践
draft: false
---

## 起点是一个被误判的因果

桌面挂着 linux-wallpaperengine 放一张 4K60 的视频壁纸。前一天我把它的解码路径从 nvdec 改成了软解，
理由是省显存：实测 nvdec 要 1385 MiB，软解只要 305 MiB，整个服务从 1586 MiB 落到 490 MiB 上下。

第二天感觉壁纸变卡了。最自然的怀疑是：软解跟不上 4K60。

这个怀疑很好听，而且时间上对得起来，所以值得先证伪它。

## 解码有 6.8 倍余量

先量单独解码能跑多快：

```bash
mpv --no-config --no-audio --hwdec=no --vo=null --untimed --length=12 柠檬_1.mp4
# elapsed 1.76 s, cpu 788%
```

12.02 秒的片子 1.76 秒解完，吃 7.88 核，也就是实时速度的 6.8 倍。同一时刻线上那个渲染进程只占
1.2 核，整机 28 线程里 94% 空闲。软解在这台机器上有大把余量。

那卡在哪。该量的是**上屏的帧率**。解码能力已经量过了，它不是瓶颈。没有现成工具，
就用 grim 连抓背景层的一条窄带，数相邻两帧不同的次数：

```bash
for i in $(seq 1 150); do
  grim -g "0,2150 3840x8" -t ppm - | sha1sum
done | uniq | wc -l
```

150 次抓图耗时 2721 毫秒（每次约 18 毫秒），其中相邻不同的有 70 帧，约合 25.7 帧/秒。

对照 `linux-wallpaperengine --help`：

```
-f, --fps  Limits the FPS to the given number [nargs=0..1] [default: 30]
```

默认 30。片源是 60 帧，于是每两帧丢一帧；剩下的 30 帧再落到 100 Hz 的面板上，100 除以 30 除不尽，
每帧停留的刷新周期数在 3 和 4 之间跳。看着就是一顿一顿的。

`git log -S'--fps'` 显示这个参数从来没写进配置过，所以这道限速跟前一天换软解毫无关系，只是那天之后
才被注意到。

加上 `--fps 60` 之后再量：相邻不同帧升到 44/秒（grim 每次抓图 18 毫秒，采样上限只有 56/秒，
所以这个数读不出真实帧率，只能证明上限被抬起来了）。CPU 1.0 核，渲染器占的显存 505 MiB，
跟 30 帧时的 490 MiB 一个量级。

## 修好一个问题，放大了另一个

第二天壁纸开始每隔一个多小时闪一下。查 journal，是我给看门狗加的内存回收在触发，09:30 和 10:46 各一次，
间隔 76 分钟。

这条回收是前一天顺手加的止血：这个渲染进程的常驻内存一直在涨，systemd 自己在 journal 里记过
12 分钟 856 MB，一个跑了 6 小时 42 分的实例 RSS 到了 1.5 GB。进程没有值得保存的状态，
过了水位重开一个就行。

问题在于泄漏的速度跟渲染的帧数成正比，而我刚把帧率翻了一倍。泄漏也就跟着从 10 MB/min 涨到 19 MB/min，
一小时出头就顶到 2 GiB。

### 水位阈值需要一道年龄闸

止血逻辑很短，但有一个坑值得单独写。判水位的条件认不出「这张壁纸本来就大」：已订阅的 52 项里有一项
web 类壁纸，它的 CEF 子进程记在同一个 cgroup 里，还有 22 项 video 类，最大的素材目录 437 MB，
而 page cache 也算进 `MemoryCurrent`。

哪张壁纸刚起来基线就在阈值以上，看门狗每 30 秒就会回收它一次。而 30 秒这个间隔永远撞不上 systemd 的
start-limit，于是它不会停在 failed 让人发现，只会一直闪下去。

解决办法是加一道年龄闸：单元活起来不满一小时就不看内存。最坏情况变成每小时闪一次，而真的漏是几小时
量级，该回收的照样回收得到。

另外，`MemoryCurrent` 读不出来的时候（systemd 报 `[not set]`、`infinity`，或者单元刚起来还没记账）
必须当作「没有数据」处理。把非数字当 0 会让这条永不触发；当极大值会让它每 30 秒回收一次。

## 五组对照把范围压到一条路上

止血能用，但它不解决问题。接下来是找漏点。

第一组对照完全不碰桌面：单独跑 mpv 软解同一个文件循环，`--vo=null`。

```
530232 KB → 532624 KB   5.5 分钟只涨 2 MB
```

解码器本身是干净的。

然后是渲染器自己的几组，每组约 4.5 分钟，只读 `/proc/<pid>/status` 的 VmRSS 取首尾算斜率：

| 组 | 斜率 |
| --- | --- |
| 软解 `--fps 30` | 10.0 MB/min |
| 软解 `--fps 60` | 18.9 MB/min |
| 硬解 nvdec `--fps 60` | 17.8 MB/min |
| 软解 `--fps 60` 且 `--no-fullscreen-pause` | 21.3 MB/min |

三条结论一次拿到：泄漏跟渲染的帧数成正比（30 到 60 大约翻倍）；跟解码路径无关（硬解和软解一样漏）；
跟那个全屏暂停门也无关。

再看涨在哪块内存上。抓两份 `/proc/<pid>/smaps` 相隔三分钟做差：

```
总 RSS 748 MB -> 817 MB   (+69 MB / 3 min)
   +54.5 MB   [heap]
   +14.4 MB   [anon rw]
```

涨的是进程自己的堆。显卡驱动的那些映射一动没动，「显存对象在 CPU 侧的账」这类解释就此排除。

## heaptrack 定到了确切的分配点

有了「每帧一次、在堆上」这两个约束，就该上分配器 profiler 了。

```bash
heaptrack -o ht linux-wallpaperengine --screen-root DP-1 --layer background --fps 60 …
heaptrack_print -f ht.zst --print-leaks 1 --filter-bt-function mpv_render_context_render
```

结果：

```
24.07M leaked over 81162 calls
23.95M leaked over 4598 calls from:
    libnvidia-eglcore.so.595.99.02
    ra_gl_ctx_submit_frame        (libmpv.so.2)
    done_frame                    (libmpv.so.2)
    render                        (libmpv.so.2)
    mpv_render_context_render     (libmpv.so.2)
    GLPlayer::render() const      (linux-wallpaperengine)
    CWallpaper::render(…)
    RenderContext::render(…)
    surfaceFrameCallback(…)
    …
```

82 秒、60 帧，4598 次调用，正好一帧一次；23.95 MB 除以 4598 是每次 5.2 KB，和从内存曲线反推的
5.4 KB 对得上。

分配发生在 NVIDIA 的 EGL 实现里，调用它的是 mpv 交帧那一步，触发它的是渲染器每帧一次的
`mpv_render_context_render`。

### 关于 heaptrack 的一个陷阱

不加 `--filter-bt-function` 直接看「泄漏总量」会被带偏。这次的进程是被 SIGKILL 掉的，
heaptrack 把「进程死时还没释放的一切」都算成泄漏，于是报告顶端是 502 MB 的 `av_malloc`，
栈指向 ffmpeg 的 h264 帧缓冲池。

那 502 MB 是**活着的**缓冲池。同一份报告里峰值堆 547 MB、总泄漏 545 MB，两个数几乎相等，
本身就说明这份「泄漏」等于「全部在用的堆」。

真正有用的是按调用栈过滤之后，那个次数正好等于帧数的条目。

## 补丁只解决了四分之一

读源码，`GLPlayer::render()` 调完 `mpv_render_context_render` 就结束了，从不调
`mpv_render_context_report_swap`。libmpv 的 render API 要求客户端在缓冲区真正交换之后报一次，
它才知道这帧结束了。

补上这一句，重新编译，再量：

```
补丁前   18.9 MB/min（同条件几次跑落在 17.8 ~ 21.3）
补丁后   14.0 MB/min
```

降了约四分之一。这是一个确实存在的上游 bug，补它是对的。内存问题它没解决。

最后一组对照回答了「剩下四分之三在谁那里」：换一张 scene 类壁纸，同一个渲染器、同一个背景层、
同样 `--fps 60` 的帧循环，只是不经过 libmpv。

```
scene 类 60 帧   287 MB → 287 MB   0.0 MB/min
```

一字节没涨。所以剩下的部分要经过 libmpv 的 render API 才发生。

这条对照能证到的就到这里了。那张 scene 壁纸只有 2 MB，每帧究竟画了多少东西没量过，可能就是张静态图，
所以它说明的是「泄漏要走 libmpv 那条路」，说明不了「渲染器自己的 GL 一样忙却不漏」。要把 libmpv 和
闭源驱动分开，得换一块非 N 卡，或者写个直接打 render API 的最小复现，两样都还没做。

## 顺手踩到的几个坑

**用 `systemctl show` 判断配置有没有生效会看走眼。** 我跑
`systemctl --user show -p ExecStart linux-wallpaperengine | grep -c 'fps 60'` 得到 0，
据此断言「新配置还没生效」，其实早就生效了。ExecStart 指向的是 store 里的一个脚本路径，
标志写在那个脚本里面，unit 文本里根本看不到。正确的做法是把路径解出来再看内容：

```bash
es=$(systemctl --user show -p ExecStart --value <unit> | sed -n 's/.*path=\([^ ;]*\).*/\1/p')
grep -o -- "--fps [0-9]*" "$es"
```

同理，`systemctl cat` 里 grep 一个由 `writeShellApplication` 生成的脚本内容，永远是 0。

**heaptrack 的 LD_PRELOAD 会打断 dlopen 链。** 这个渲染器经 sdl2-compat 去 dlopen
`libSDL3.so.0`，在 heaptrack 下直接打一句 `Failed loading SDL3 library.` 然后退出，
trace 只有 0.08 秒。把 SDL3 的 lib 目录显式加进 `LD_LIBRARY_PATH` 才跑得起来。同样地，
如果为了关掉硬解而把 `LD_LIBRARY_PATH` 整个覆盖成 `/run/opengl-driver/lib`，也会把 SDL3
的搜索路径盖掉。

**grim 采样有自己的上限。** 每次抓图约 18 毫秒，也就是采样率约 56/秒，把区域从 3840x8 缩到 200x8
也没变快，说明它等的是合成器出帧，拷贝像素那点开销无关紧要。用它区分 30 帧和 60 帧够用，
量 60 帧以上就不行了。

**手工停服务做实验，收尾要等干净。** 我几次在自己的进程还没死透的时候就 `systemctl start`，
新进程抢不到背景层，报 `Failed to bind to required interfaces` 退出 1，连撞五次 start-limit
停在 failed，桌面白等。收尾脚本要轮询到旧进程消失再启动，并且带上 `reset-failed`。

## 这份补丁怎么养

泄漏还剩四分之三，回收看门狗继续留着兜底，触发间隔从 75 分钟变成约 100 分钟。

补丁在这个 NixOS 仓库里是一个 overlay 加一个 `.patch`，头注释写清楚了退场条件：上游把这句加进去之后，
删掉 overlay、`.patch` 和 `overlays.nix` 里的引用。上游 bump 之后补丁对不上行号会让 build 硬失败，
那是好事，重新对一次即可，不要改成 `--fuzz` 之类把它静默吞掉。

给这类「上游源码补丁」写头注释的时候，把测量数字和复量命令一起写进去。半年后再看，
光有一句「补上 report_swap」没法判断它还值不值得留。
