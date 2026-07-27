---
title: "给 Claude Code 装一条状态栏:选型、数据来源,以及 NixOS 上的声明式落地"
published: 2026-07-27
description: "statusLine 是官方一等扩展点而非擦边球,但选错 widget 会让状态栏拿你的 OAuth 凭据去调内部接口。"
tags:
  - "Claude Code"
  - "NixOS"
  - "终端"
  - "工具选型"
category: 技术实践
draft: false
---

我原来的 Claude Code 状态栏是一个 12 行的 shell 脚本,只打印一个 `[PONYTAIL:FULL]` 标记,告诉我当前插件在哪个档位。一整条状态栏被这一个标记占着,剩下的空间全空着。

这篇记的是把它换成 ccstatusline 的完整过程:这类插件是不是官方支持的、几个候选怎么选、**引入前最该搞清楚的那件事**、以及在 NixOS 上怎么做到不碰 TUI 就配置好。

## 一、先确认这是不是擦边球

装第三方状态栏之前我先查了这个问题,答案很干净:**`statusLine` 是 Claude Code 文档里的一等扩展点。**

settings.json 里配一条 command,Claude Code 每次渲染时把会话 JSON 从 stdin 喂进去,脚本打印什么就显示什么。官方还内建了 `/statusline` 斜杠命令,可以直接用自然语言让 Claude 帮你生成脚本并改配置。

stdin 那份 JSON 官方给的字段包括:

| 字段 | 内容 |
| --- | --- |
| `model` | 模型 id 与显示名 |
| `workspace` / `cwd` | 工作目录 |
| `context_window` | 窗口大小、已用 token、百分比 |
| `cost.total_cost_usd` | 会话花费(**客户端本地估算**) |
| `rate_limits` | 额度桶,含 `used_percentage` 和 `resets_at` |
| `effort` | 当前思考档位 |
| `transcript_path` / `session_id` | 会话标识 |

第三方状态栏做的事就是读这份 JSON 再排版。**没有反编译,没有钻内部接口。**

**但有一条例外,后面第三节会讲——那是引入这类工具时唯一真正需要警惕的地方。**

## 二、选型:三个候选

我看了三个。

**best-claude-hud**(Rust,npm 分发预编译二进制)。star 数不低,但整个仓库只有三十几个 commit,功能面窄。它主打的独特卖点是显示 reasoning effort 档位——我后来发现 ccstatusline 也有这个 widget,所以这点独占性并不成立。在 NixOS 上,npm 全局装预编译二进制是脏路径,要么 `nix-ld` 兜着要么自己打包。**否掉。**

**claude-powerline**。视觉最统一,plugin-native 路径最干净。功能面比 ccstatusline 窄。

**ccstatusline**。widget 最全(接近九十个),配置是 `~/.config/ccstatusline/settings.json` 一个纯 JSON,有 TUI 但不强制,主题和分隔符全可自定义。**选它。**

选 ccstatusline 的决定性理由不是"功能多",而是**配置是纯 JSON**。这意味着我可以用 Nix 生成它,不用打开 TUI 点一遍——对一个声明式配置仓库来说这是硬需求。

顺带一提,如果你只是想要个能用的,`/statusline` 官方命令生成的脚本足够了,二十行搞定,还不用管上游打包。我走第三方路线是因为想要额度、缓存命中率这些自己写起来麻烦的东西。

## 三、引入前最该搞清楚的:数据从哪来

这是整篇里最值钱的一节。

ccstatusline 显示额度百分比有两条数据来源:

1. Claude Code 从 stdin 喂进来的 `rate_limits` 字段
2. **回退路径**:某个 widget 需要的桶在 `rate_limits` 里找不到,它就去读 `~/.claude/.credentials.json` 里的 OAuth token,调内部用量接口,再把结果连同 token 哈希缓存到 `~/.cache/ccstatusline/usage.json`

第二条决定了这条状态栏的性质。

我一开始读上游 schema,看到 `rate_limits` 声明了四个桶——`five_hour`、`seven_day`、`seven_day_opus`、`seven_day_sonnet`——就照着选了对应的四个 widget,并且很有底气地下结论:全部由官方字段供数,不会触发回退。

**这个结论是错的。**

抓一份真实负载看(方法见下),Claude Code 实际只发两个桶:

```json
"rate_limits": {
  "five_hour": {"used_percentage": ..., "resets_at": ...},
  "seven_day": {"used_percentage": ..., "resets_at": ...}
}
```

`seven_day_opus` 和 `seven_day_sonnet` 从来不发。schema 里声明它们是为了向前兼容和兼容迁移过的账号——**schema 说的是"可能有什么",不是"实际发什么"**。

于是那两个 per-model widget 一直在走回退路径,每 180 秒拿我的凭据发一次请求。而接口返回的 `weeklyOpusUsage`、`weeklySonnetUsage` 都是 `0`,它们是遗留字段。**用凭据换了两个恒零的数字。**

### 抓真实负载的方法

成本很低,一个 tee 旁路脚本:

```bash
#!/usr/bin/env bash
exec 3>&1
tee -a /tmp/payload.jsonl | exec ~/.bun/bin/ccstatusline >&3
```

把 `statusLine.command` 临时指过去,等一次渲染,还原。即使脚本出错状态栏也照常工作(它 exec 了真正的二进制)。

### 结论:哪些 widget 会拿凭据

按实际负载,**只有 `session-usage`(5 小时)和 `weekly-usage`(7 天)是官方字段直供的**。以下这些都会触发回退路径:

- `weekly-opus-usage` / `weekly-sonnet-usage` — 而且值恒为 0
- `fable-weekly-usage`
- `extra-usage-utilization` / `extra-usage-remaining` / `extra-usage-used` — 这三个还要求你开了 usage credits

**如果你在意"这条状态栏会不会拿我的凭据发请求",选 widget 时就只能用前两个。**这是引入这类工具时最实际的一条判据,比功能对比重要得多。

我把它固化成了自检里的一条断言,两层:静态查配置里有没有这类 widget;运行时植入一份假凭据渲染一次,断言 `~/.cache/ccstatusline/` 下没有 `usage.*` 痕迹(痕迹在请求**发起时**就写,所以离线也成立)。两层都实测过加回 `weekly-opus-usage` 时会失败。

### 顺带:`session-cost` 也别要

`cost.total_cost_usd` 官方文档写得很明白:"computed client-side. May differ from your actual bill."——它是**客户端本地估算的等价 API 价格**。订阅制且没开 usage credits 的话,这个数字既不对应账单,也不对应任何你能采取的行动。真正的预算信号是那两个额度百分比。

## 四、NixOS 上的声明式落地

ccstatusline 不在 nixpkgs。仓库里 Claude Code 本身就是 bun 全局装的,所以走同一条路,注册成后台刷新服务的一个步骤:

```nix
netRefresh.steps.ccstatusline.order = 22;   # 排在 claude 步骤(20)之后
netRefresh.steps.ccstatusline.script = ''
  bunAddGlobal "ccstatusline@latest"
  if ! verifyCcstatuslineInstall; then
    repairCcstatuslineInstall "version drift detected"
    verifyCcstatuslineInstall
  fi
'';
```

`verify` 那步比看起来重要:状态栏**每次渲染都要跑一次**,如果 bun 的全局 bin 还指着旧版,你不会有任何察觉。所以校验装好的 `package.json` 版本和二进制自报版本是否一致,不一致就重装一次。

配置文件用仓库既有的 helper 物化成**真实可写文件**(不是 store symlink),每次激活覆盖:

```nix
(materializedConfigFile {
  target = "ccstatusline/settings.json";
  text = ccstatuslineSettings;
})
```

覆盖式权属的含义是:**TUI 仍然能打开当预览,但它写回的改动会在下次 rebuild 时被抹掉。**要改布局就改 nix 文件。这正是我要的语义——配置的唯一真相在仓库里。

布局本身单独一个文件,是个接受 `{ ponytailStatusLine }` 的函数,返回 JSON 字符串。独立成文件是为了让自检脚本能单独求值它,拿去和磁盘上的 `settings.json` 比对漂移。

Nix 没有 unicode 转义,写 Nerd Font 码位可以借 JSON 的 `\u`:

```nix
glyph = code: builtins.fromJSON "\"\\u${code}\"";
```

比在源码里直接塞私用区字形可读得多。

## 五、布局:三条纪律

配到能看,我返工了三次。最后固化成配置文件头部的三条纪律。

### 宽度

第一版第三四行末尾都是省略号。我以为是 widget 太多,差点开始砍功能。真正的原因是配置默认值:

```ts
if (flexMode === 'full-minus-40') {
    return detectedWidth - 40;   // 无条件
}
```

终端 96 列,实际可用只剩 56。换成 `full-until-compact`,平时只减 6 列,仅在上下文逼近压缩阈值、宿主要在右侧贴提示时才让出那 40 列。

**削减内容之前先确认预算到底有多少。**另外,截断不报错、不返回非零,只是安静地把行尾吃掉——而行尾恰好是我最在意的标记。所以自检里加了一条宽度上限断言,任何让某行变宽的改动都会先在那里失败。

### 标签

工具有个 `rawValue` 开关,打开就去掉 widget 自带的文字前缀。我全开了,宽度从 130 列压到 74 列。

然后发现读不懂:

```
56.0% · 1h22m · 47.0% · 1d13h52m · $17.85 · 2h18m · none
```

哪个是五小时、哪个是七天,全靠背。**标签不是装饰,是这些数字唯一的语义来源。**

钟摆两端都错:上游自带的 `Weekly Opus: ` 太长放不下,全删又变成无意义字符。落点在中间,用短标签。工具没提供这个能力,但可以用一个合并进后面 widget 的文本前缀凑出来:

```nix
labeled = text: item: [
  { type = "custom-text"; customText = text; merge = "no-padding"; color = muted; }
  item
];
```

结果是 `5h 62.0% reset 57m · 7d 48.0% reset 1d13h27m · session 24m`,84 列。

### 配色

第一版用逐 widget 的 powerline 色块,主题选的和终端同源的 catppuccin。一行九个饱和背景块轮着来,结论是"完全看不清"。

**背景色块的可读性取决于前景背景的运气**,九个块就是九次配对,撞上一次低对比度那段就糊了。而且主题的调色板是为**前景**设计的,粉色当文字好看,刷成整块背景就刺眼。

关掉色块只留前景色之后还翻车一次:工具的默认前景色是 `#4e9a06`、`#3465a4`、`#75507b` 这套——**Tango 调色板**,2004 年 GNOME 终端的默认配色。

最后定的是**两个中性色 + 一个强调色,没有第四种**:强调色只标"我是谁 / 我在哪"(模型名和 git 分支,全屏只有这两处有彩色),主文本色给数值,次级色给单位、标签、计数、倒计时。

渐变也试过,给进度条上绿→黄→红。填充到 28% 时后半段仍然是红的——**那不是信息,是会误导的装饰**。删了。

## 六、坑清单

按被坑的顺序:

- **`flexMode` 默认吃掉 40 列。**见上。
- **空 widget 会留下孤立的前缀。**合并进来的图标或标签不会跟着它装饰的 widget 一起消失。干净仓库下 `git-changes` 渲染为空,前缀还在,变成一个孤零零的标签。凡是可能渲染为空的都不能加前缀。
- **`rawValue` 会改变空值语义。**`worktree-mode` 的 raw 分支返回字面量 `'true'`/`'false'`,不在 worktree 时状态栏上就明晃晃写着 `false`;而它的默认分支在同样情况下返回 `null`,正好该什么都不显示。一个"去掉标签"的开关顺带改了空值行为,这不是从名字能猜到的。
- **widget 的 `type` 是 `z.string()`。**上游为向前兼容放宽了类型,打错不会报错,只会静默渲染成空。自检里因此有一条专门比对 type 全集。
- **填充用的是不换行空格(U+00A0)。**写断言时如果用普通空格去匹配 `Opus 5`,会因为中间那个字节不同而假失败。归一化时**用显式字节 `\xc2\xa0` 写模式**,不要在源码里直接打那个字符——它和普通空格长得一模一样,打错了替换会静默失效。
- **有些图标是硬编码的。**`compaction-counter` 的 ↻ 不走 `character` 覆盖槽,加文字标签就成了 `cmp ↻ 0`。得用 `metadata.format = "number"` 让它只吐数字。
- **符号不要一符多义。**我一度在第三行用 `↻ 0` 表示压缩次数、第四行用 `↻1h12m` 表示重置倒计时,自己写的自己都要想一下。图标只在"图形本身就是那个东西"时才用——文件夹、分支、时钟;表示"哪个百分比"这种需要辨认的位置一律用文字。

## 七、最终形态与值不值

```
 Opus 5 · think high · style default · cc 2.1.220
 .../tk_go_gateway ·  dev · (+0,-0)
ctx 18.1% · ▓░░░░░░░░░ · 144.6k/1.0M · compact 0 · cache 97.4% · ttl 🟢 4:37
5h 62.0% reset 57m · 7d 48.0% reset 1d13h27m · session 24m · skill none · [PONYTAIL]
```

四行,最宽 86 列,原来那个 ponytail 标记降级成第四行末尾的一个 widget 活了下来。

**值不值:** 如果你只想要模型名和 context 百分比,`/statusline` 官方命令二十行搞定,不用装任何东西。第三方的价值在于额度窗口、缓存命中率、压缩次数这些自己写起来麻烦的东西——尤其是**额度和重置倒计时**,它让"还能跑多久"从猜变成看一眼。

**引入时唯一要认真做的一件事:抓一份真实的 statusLine 负载,搞清楚你选的每个 widget 的数据从哪来。**照 schema 推断会得出错误的结论,而错误的方向恰好是"以为不发请求,实际在发"。

**不适用的场景:**终端窄于 90 列的话四行布局会很挤,建议砍到两行;不用 Nerd Font 的话图标全是豆腐块,把 `icons` 那一段清空即可;不走声明式配置的话直接用 TUI 更省事,这篇里 Nix 的部分可以整节跳过。
