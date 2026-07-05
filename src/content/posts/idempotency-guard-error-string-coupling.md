---
title: "幂等 guard 别拿错误字符串当契约:一次 SQLite→Postgres 迁移埋下的重部署死锁"
published: 2026-07-05
description: "一条只认 SQLite 错误文案的幂等守卫,在数据库换成 Postgres 后让 headscale 每次重部署都卡死 exit 1;记录根因、修复,以及顺带踩到的管道退出码陷阱。"
tags:
  - "运维踩坑"
  - "幂等性"
  - "Postgres"
  - "headscale"
category: 技术实践
draft: false
---

## 背景:一次例行镜像更新，暴露了半年前的地雷

这次任务本身很平淡：把自托管的十几个服务镜像批量升到最新稳定版，逐个 `deploy`
＋健康校验＋原子提交。真正值得写下来的，是部署 headscale 时冒出来的一个报错——
它跟本次镜像升级毫无关系，却让这个服务**每一次重部署都必然失败**，而且已经潜伏了一段时间。

报错长这样：

```
Error: creating user: rpc error: code = Internal desc = creating user:
creating user: ERROR: duplicate key value violates unique constraint
"idx_name_no_provider_identifier" (SQLSTATE 23505)
```

部署退出码 `1`，健康校验直接判死。但容器其实都起来了、服务也能用——
挂掉的只是部署流程里一个**本应幂等**的 post-deploy 步骤。

## 根因:守卫在用错误文案做判断，而文案是后端相关的

这个服务的部署脚本里，有一步是"确保管理员用户存在"。它的写法是"创建，失败了就看是不是
因为已存在，是的话就当无事发生"——标准的幂等模式。问题出在"是不是因为已存在"这句判断上：

```bash
_OUT=$(headscale users create yb 2>&1) || {
  echo "$_OUT" | grep -Eqi 'already exists|constraint failed|UNIQUE constraint failed' \
    || { echo "$_OUT" >&2; exit 1; }
}
```

这段 guard 的意图完全正确：创建失败 → 如果错误信息表明"已存在/唯一约束冲突"，就吞掉；
否则才真报错退出。

但它匹配的三个模式——`already exists`、`constraint failed`、`UNIQUE constraint failed`
——全是 **SQLite** 的措辞。而这个服务此前已经从 SQLite 迁到了 Postgres。
Postgres 对同一件事的说法完全不同：

```
duplicate key value violates unique constraint "..." (SQLSTATE 23505)
```

`grep` 匹配不上 → 走进 `exit 1` 分支 → 幂等步骤变成硬失败。用户明明早就存在，
守卫却因为"没听懂 Postgres 的话"而把它当成致命错误。

**这就是核心教训:任何拿错误信息字符串做分支判断的守卫，都隐式耦合了产生这条错误的后端。**
换了数据库、换了驱动、甚至上游只是改了一版报错文案，守卫就会静默失效——而且失效方向往往
最坏:一个为了"更幂等"而写的保护，反而变成了阻塞。

## 修复:先止血，再想根治

止血很简单，一行,把 Postgres 的措辞补进 grep 的候选集:

```bash
grep -Eqi 'already exists|constraint failed|UNIQUE constraint failed|duplicate key value|SQLSTATE 23505'
```

改在**唯一的那处共享守卫**上,不是在调用方补丁——这也是"根因修复而非症状修复"的体现:
所有路径都从这一处 create 走过,补一处就够，补调用方则会漏。改完重部署，退出码 `0`,
tailnet 重新加入、UI 健康检查通过。

顺手确认了没有别的 stack 复用同款 SQLite 时代的守卫、也没有测试把这段字符串钉死,
才敢动。

更彻底的做法（这次没做，因为超出止血范围，但值得记下）:

- **别用错误文案，用语义**。SQLSTATE `23505` 是 SQL 标准里"唯一约束冲突"的稳定代码,
  按 SQLSTATE 判断比按人类可读文案判断稳得多——它不随驱动和语言环境漂移。
- **或者干脆让操作真正幂等**，把"create 然后吞错误"换成"先查后建"或数据库原生的
  `INSERT ... ON CONFLICT DO NOTHING`,从源头上不产生这条需要被 grep 掉的错误。

字符串匹配是"事后补救",而 SQLSTATE / ON CONFLICT 是"事前约定"。守卫的健壮性,
取决于它依赖的东西有多稳定。

## 附带踩到的第二个坑:`| tail` 会吃掉退出码

排查时差点被自己误导。我最初批量部署是这样写的:

```bash
for s in ntfy general headscale; do
  ops service deploy $s --yes 2>&1 | tail -8
  echo "EXIT[$s]=$?"
done
```

结果 headscale 明明在输出里打了 `Error: ...`，`EXIT[headscale]` 却显示 `0`。

原因是管道:`$?` 取的是管道**最后一个命令**的退出码,也就是 `tail` 的——`tail` 几乎永远
返回 0。真正的 `ops` 退出码被管道吞了。改成不带管道、把输出重定向到文件再单独看,才拿到
真实的 `EXIT=1`:

```bash
ops service deploy "$s" --yes >/tmp/dep_$s.log 2>&1; echo "EXIT=$?"
```

（Bash 里也可以用 `${PIPESTATUS[0]}` 取管道第一段的退出码。）这个坑很老,但在"批量跑一堆
部署、靠退出码判断成败"的场景里特别致命:它会让一个失败的部署伪装成成功,而你还以为验证过了。

## 可复用的结论

1. **错误字符串是 UI，不是 API**。任何 `grep '<某段报错>'` 的判断逻辑,都要假设这段文案
   会变——换后端、换驱动、升级上游都可能触发。能用错误码（SQLSTATE、errno、gRPC status）
   就别用人话。
2. **幂等的最佳实现是"不产生错误",而不是"产生错误再吞掉"**。`ON CONFLICT`、先查后建、
   `CREATE ... IF NOT EXISTS` 这类原生幂等,比"try/catch 错误文案"少一层脆弱耦合。
3. **数据存储迁移的尾巴很长**。数据搬完、服务能跑，不等于迁移完成——所有"顺带依赖旧后端
   行为"的脚本（错误文案、锁语义、事务隔离、大小写规则、collation）都可能在几周后的某次
   重部署里才炸出来。迁移后主动 grep 一遍运维脚本里对旧后端措辞的依赖，比等它在生产里
   卡住便宜得多。
4. **批处理脚本先确认退出码取的是对的那一段**。`cmd | tail`、`cmd | tee` 之后的 `$?`
   都不是 `cmd` 的,这会让失败静默通过。
