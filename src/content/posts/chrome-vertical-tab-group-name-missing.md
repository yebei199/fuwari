---
title: "标签组名消失的三小时:一次被 X11 骗了半程的排查"
published: 2026-07-13
description: "Chrome 垂直标签栏不显示标签组名称,真正的原因藏在 xdg-desktop-portal 报出的一个并不存在的字体里。"
tags:
  - "Chrome"
  - "Wayland"
  - "字体"
  - "调试"
category: 技术实践
draft: false
---

Chrome 150 开了 `vertical-tabs` 这个实验开关之后,竖排标签栏里的标签组只剩一条彩色横条和折叠箭头,组名一个字都不显示。名字明明输了,回车也按了。

这个 bug 的排查过程里我错了四次。之所以值得写下来,是因为**每一次错误的假设都能被"验证通过"**:我提出的绕过方案确实让组名回来了,只是原因完全不是我以为的那个。这类"修好了但理由是错的"最危险,它会直接变成一条长期存在于配置里的错误决策。

## 先确认现象本身

第一步不是猜,是把问题**钉死在某一层**。

用 niri 自带的截图抓整屏:同一张图里,标签页标题、书签栏、页面正文,所有文字渲染正常;只有标签组的头部是几条纯色横条。合成器和字体渲染都没问题,截图忠实反映了 Chrome 自己画出来的东西——**问题在浏览器里,不在系统**。

然后确认名字到底存没存下来。Chrome 的 session 文件是二进制,字符串按 UTF-16 存,普通 `strings` 抓不到,要指定编码:

```bash
strings -e l -n 2 ~/.config/google-chrome/Default/Sessions/Session_* | grep -ix "fun"
```

三个 session 文件里都躺着 `fun`。**名字保存成功,是 UI 没画出来。**

再从 Chrome 二进制里捞类名:

```bash
strings -n 8 .../share/google/chrome/chrome | grep -oE "VerticalTab[A-Za-z]*" | sort -u
```

`VerticalTabGroupHeaderLabel`、`VerticalTabGroupHeaderView` 都在。**标签是实现了的,不是"这版没做"。**

到这里,问题的形状已经很清楚:一个存在的控件,拿着正确的数据,画出了空白。

## 四次错误的假设

**其一,配色主题。** 用户的 `Preferences` 里有 `extensions.theme.id = "user_color_theme_id"`,自定义配色。我猜标签的前景色和填充色算成了同一个,文字隐形了。用户换了好几个颜色,没用。

**其二,Vulkan。** 每次 Wayland 启动日志里都有 `'--ozone-platform=wayland' is not compatible with Vulkan`。看着很像。`--disable-features=Vulkan`,没用。

**其三,GPU 合成路径。** 机器是 NVIDIA,Wayland 走 EGL、X11 走 GLX,两条路完全不同。`--disable-gpu`,没用。

**其四,也是最坑的一次:Wayland 本身。** 我起了一个干净 profile、默认主题、只开一个 flag 的探针实例,分别在 Wayland 和 X11 下跑。Wayland 复现,X11 正常。分数缩放也排除了(两个输出都是 `Scale: 1`)。

于是我下了结论:**Chrome 的 vertical tabs 在 ozone/wayland 路径下有渲染缺陷。** 然后给仓库加了一个强制 `--ozone-platform=x11` 的桌面项作为绕过,写了注释,提交,推送。

这个方案是**有效的**——组名确实回来了。它也是**错的**。

## 转折:去搜一下有没有人报过

真正该早点做的事,是先去 Chromium issue tracker 搜。搜到 [issue 526437586](https://issues.chromium.org/issues/526437586),标题写着 `[Linux][VerticalTabs] Tab group title is not visible when GNOME UI font uses Ubuntu Sans Medium`,状态 Fixed。负责人的 RCA 一句话说穿:

> The tab group label has a fixed max height (`kGroupHeaderHeight = 26px`), so if the requested font has a larger height, it results in height of 0px. For example, Noto Sans 12pt resolves to line height of 28px.

**UI 字体的行高超过写死的 26px,标签高度就被算成 0。** 和 Wayland 没有半点关系——报告人是在 X11 会话下复现的。

我的 X11 方案能"生效",纯属侥幸:X11 那条路径解析出的字体恰好更小,压在了 26px 以内。**同一个现象,两个完全不同的原因,而我验证的是现象。**

## 真正的根因:一个不存在的字体

顺着字体这条线继续。先查默认无衬线字体:

```bash
$ fc-match sans-serif
MapleMono-NF-CN-Regular.ttf: "Maple Mono NF CN" "Regular"
```

默认 sans 是一个等宽 Nerd Font。Nerd Font 为了塞图标,行高普遍撑得很大——这是配置里 `defaultFonts.sansSerif` 把 Maple 排在第一位的结果,本身是个有意为之的选择。

但接着我又错了一次:我用 `XDG_CONFIG_HOME` 塞了一份 `gtk-3.0/settings.ini`(把 UI 字号压到 8pt)和一份 `fontconfig/fonts.conf`(把 sans-serif 换成 Noto Sans),两个探针**毫无反应**。一点变化都没有。

这个"毫无反应"本身就是线索:**Chrome 在 Wayland 下压根不读这两个来源。** 它走的是 xdg-desktop-portal。

```bash
gdbus call --session --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop \
  --method org.freedesktop.portal.Settings.ReadAll "['org.gnome.desktop.interface']"
```

portal 报出来的是:

```
font-name           = 'Adwaita Sans 11'
text-scaling-factor = 1.0
```

**而这台机器根本没装 Adwaita 字体。**

链条到这里才闭合:

1. dconf 里 `font-name` 是空的,portal 就报出 GSettings schema 的默认值 `Adwaita Sans 11`;
2. 这个字体不存在,fontconfig 回落到默认 sans,也就是 Maple Mono NF CN,而且是 **11pt**(比 GTK 内建默认的 10pt 更大);
3. 这个字号下它的行高顶破了 26px;
4. 标签高度算成 0,组名不绘制。

X11 不问 portal,拿到的是另一套更小的字体,所以看起来"正常"。

验证很直接:把 dconf 显式设成 `Maple Mono NF CN 9`,重启探针,组名回来了。10pt 也可以,11pt 又没了。**临界点就在 10 和 11 之间**,和上游的 26px 上限完全对得上。

## 修复与取舍

最终的修法是一行配置,把 portal 会读的那个 key 钉死:

```nix
dconf.settings."org/gnome/desktop/interface" = {
  font-name = "Maple Mono NF CN 10";
  document-font-name = "Maple Mono NF CN 10";
  monospace-font-name = "Maple Mono NF CN 10";
};
```

那个 X11 桌面项被删掉了。它治的是标,而且理由是错的。

这里有个逃不掉的取舍:26px 是死上限,用户想要 14pt 的 UI 字体,**任何字体在 14pt 下都不可能压进 26px**。所以在上游修复(M151 移除了这个上限)进入 stable 之前,只能二选一:大字号但看不到组名,或者 10pt 但组名正常。这个取舍必须交给用户决定,而不是替他选一个。

## 几条可复用的东西

**"修好了"不等于"找对了原因"。** X11 方案通过了验证,组名确实回来了,我甚至已经提交推送。真正的原因是字体行高,X11 只是碰巧绕开了它。当一个绕过方案有效但你说不清它为什么有效,那就还没排查完。

**先去搜上游 issue,再动手猜。** 我在自己的假设上烧掉了大半时间,而 issue tracker 里那条 RCA 一句话就说清了。搜索的成本远低于四轮猜测。

**"毫无反应"是一种信息。** 改了配置却一点变化都没有,通常不代表"这个方向不对",而代表"这个配置根本没被读到"。这一步直接指向了 portal。

**顺带发现的配置漏洞:** portal 报出一个未安装的字体作为默认值,意味着整个 GTK 桌面的 UI 字体都在靠 fontconfig 瞎回落。不管这个 bug 怎么收场,显式声明 `font-name` 都是该做的事。
