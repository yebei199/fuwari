---
title: "三台 OLAP 单机实测之后：单机 ClickHouse，集群 Doris 或 ClickHouse，日常分析 DuckDB"
published: 2026-09-02
description: "把 ClickHouse、StarRocks、Doris 各用一份 compose 拉起来，逐条实测列级与行级授权、Parquet 摄取、方言迁移成本和开源边界，得出一个按规模分层的选型口径。"
tags:
  - ClickHouse
  - StarRocks
  - Apache Doris
  - DuckDB
  - OLAP
  - 数据治理
category: 技术实践
draft: false
---

一年前我记得 StarRocks 部署很麻烦，于是一直用 ClickHouse。这周想验证一件事：单机 StarRocks 能不能像 ClickHouse 一样一个 yml 起来。答案是能，但顺着这条线往下测，问题变成了「那为什么不换」，最后又把 Doris 也拉进来测了一遍。这篇记录测出来的数字、踩到的坑，以及最后落定的一句话：**单机用 ClickHouse，集群用 Doris 或 ClickHouse，日常分析处理用 DuckDB。**

## 测法

三台库各一份 docker compose，官方镜像，钉 digest，具名卷，同一台开发机。版本是 ClickHouse 26.7、StarRocks 4.1.4（allin1 镜像）、Doris 4.1.3（all-in-one 镜像）。

授权统一这样测：一张四列表 `sku(sku, brand, cost, qty)`，三个用户。`grafana` 只该看到 `sku, qty` 两列；`acme` 和 `borg` 各只该看到自己品牌的行。然后做四种绕过（直接读底表、只读敏感单列、拿视图 join 底表、查 `information_schema.columns`），再给底表加一列敏感字段看默认漏不漏，最后重启容器看策略和数据在不在。

## 部署：单机形态下三家都是一个 yml

| | 起到 healthy | 本地镜像体积 | 空载常驻内存 |
|---|---|---|---|
| ClickHouse | 秒级 | 1.15 GB | 0.59 GiB |
| StarRocks | 约 20 秒 | 5.24 GB | 约 1.2 GiB |
| Doris | 约 25 秒 | 4.27 GB | 1.71 GiB |

「StarRocks 部署麻烦」这个印象不是错觉，但原因不是版本旧，而是 **FE / BE 这套东西本来就是给集群准备的**。它和 Doris 的最小完整单元不是一个进程，是两个角色：FE 是 Java 写的，管元数据、SQL 解析、查询规划与节点调度；BE 是 C++ 写的，管存储与执行。两者跑不同进程、走 RPC、靠心跳互相发现。

单机部署时这套机制一样不少，只是两端都指向 `127.0.0.1`。官方手工部署要你自己配 `priority_networks`、把默认三副本改成一副本、手工 `ALTER SYSTEM ADD BACKEND` 注册 BE、管 FE 的 JVM 堆。all-in-one 镜像做的全部事情就是把这四步写进 entrypoint。所以单机形态下这两家的部署便利是镜像脚本给的，不是架构给的，而退化形态的代价还在：

- 一个容器里 JVM 的 FE 加 C++ 的 BE 两个进程由 supervisord 拉着，外加 nginx 等辅助进程，故障面比单进程大；
- healthcheck 只看得到 FE，BE 挂了容器照样报 healthy（这条是从架构推断的，我没构造出来验证）；
- BE 注册在 `127.0.0.1`，于是它不是集群的种子（将来扩容是重新部署而不是加节点），宿主机侧的 Stream Load 也只能从本机发，还带来后面那个灌错库的坑。

复杂度没有消失，被藏起来了，所以官方只把这种镜像定位成教程用。

ClickHouse 走的是反方向：从单机引擎长出来，一个静态二进制一个进程，解析、规划、存储、执行全在里面，集群是后来叠上去的（Keeper、副本表、Distributed 表），不建集群时那些代码路径根本不触发。所以 ClickHouse 单机是原生形态，另两家的单机是退化形态。一份 yml 的表象一样，里面跑的东西差一个数量级。

顺带一句，我拉的第一个 StarRocks 镜像是 3.5.4，构建于一年前。它上面 `FILES('file:///…')` 直接报 `NoSuchFieldError`，换 3.5.21 才正常。别拿旧 tag 下结论。

## 能力：ClickHouse 并不弱，是单表最强

先说这一节，因为「换个引擎能力更强」是最容易站不住的理由，而它恰好也是我原先想当然的地方。

| | ClickHouse | StarRocks | Doris |
|---|---|---|---|
| 单表扫描时聚合 | **最强** | 强 | 强 |
| 多表 join | 一般，推荐宽表 | 强 | 较强 |
| 可合并聚合状态 | **有** | 无等价物 | 无等价物 |

通用对比表里 ClickHouse 常被写成「中强」，那是按功能广度打分。但引擎选型要按负载形状选，不按功能条数选。我们的负载是：一百三十多条面板 SQL 里含 JOIN 的只有两条，mart 是去规范化的宽表视图，读取模型是「单张扁平表 + WHERE + GROUP BY」。这正好落在 ClickHouse 唯一被评为最强的那一格，而另两家的高分项（多表 join、实时 upsert）一个都碰不到。

更关键的是可合并聚合状态。看板上有五类数学上不可组合的度量：去重计数、严格合计的「未知即未知」、中位数、比率型指标、池级合并。预聚合之后这些再也算不回来。ClickHouse 用 `uniqState` / `quantileState` 这类可合并状态配 `AggregatingMergeTree`，让去重与分位数能按任意粒度合并，另两家没有等价物：精确去重只有 HLL 近似，或者要求整数键的 bitmap，而我们三十处 `uniqExact` 全打在 SKU 这种字符串键上。

诚实的边界：ClickHouse 做不到「任意维度组合都毫秒级」。排序键只有一个，过滤不落在其前缀上会退化成全表扫。准确的说法是绝大多数组合亚秒级，当前量级则是全部组合都快。

## 授权：这是分水岭

| | ClickHouse | StarRocks | Doris |
|---|---|---|---|
| 列级授权 | **原生** | **无**，语法不认识 | **原生** |
| 行级策略 | **原生** | **无**，语法不认识 | **原生** |
| 列遮蔽策略 | 无 | 无 | 无 |
| 未授列的 `SELECT *` | 拒 | 视图路径下拒 | 拒 |
| 授权后底表加列 | 新列默认看不到 | 视图列集建时冻结，不漏 | 新列默认看不到 |

ClickHouse 和 Doris 各一条语句，策略挂在表上：

```sql
-- ClickHouse
GRANT SELECT(sku, qty) ON scm.sku TO grafana;
CREATE ROW POLICY tenant ON scm.sku USING brand = currentUser() TO acme, borg;

-- Doris
GRANT SELECT_PRIV(sku, qty) ON scm.sku TO grafana;
CREATE ROW POLICY p_acme ON scm.sku AS PERMISSIVE TO acme USING (brand='acme');
```

StarRocks 开源版三条语句全报语法错。`information_schema.column_privileges` 这张表存在，但是零行的 MySQL 兼容桩。FE 的 lib 里带着 Apache Ranger 2.8.0 的 jar，那是官方的列行级路径，代价是另跑一套 Ranger 服务。

不装 Ranger 就走视图。视图路径实测能挡住四种绕过，但有三条纪律，缺一条就漏：

1. 必须撤掉底表的 SELECT，只授视图。撤掉之后 `information_schema.columns` 对该用户也查不到底表的列。
2. 视图保持默认的 `SECURITY NONE`。写成 `SECURITY INVOKER`，同样的授权下就读不到了。
3. 按身份收窄要自己拼字符串：`current_user()` 返回的是带引号的 `'grafana'@'%'`，得先剥引号再取 `@` 前面那段。

视图的列集在建视图时就冻结了，`SHOW CREATE VIEW` 能看到展开后的列名，所以 `SELECT *` 的视图不会被事后加列打穿。这一点和另两家 fail-safe 效果相同，只是保护住在视图定义里而不是表上。

## Parquet：三家都能，路不一样

| | 怎么灌本地 Parquet |
|---|---|
| ClickHouse | HTTP body `INSERT … FORMAT Parquet`，从任何地方发 |
| StarRocks | Stream Load 只认 CSV/JSON；Parquet 走 `FILES('file:///…')`，文件要在容器可见路径 |
| Doris | Stream Load 只认 CSV/JSON；Parquet 走 `local()` 表函数，路径相对 BE 工作目录 |

两个类型推断的坑：StarRocks 用 CTAS 从 FILES 建表会把 DOUBLE 变成 decimal(38,9)；Doris 的 `local()` 把 int64 推成 largeint。两家都是先显式 DDL 再 `INSERT … SELECT` 才保住原类型。

## 方言：真正的迁移成本

我们看板有一百三十多条面板 SQL 和十个视图，用正则数了一遍，约八成用了 ClickHouse 专有函数：`toDate`、`countIf`、`toInt64`、`formatDateTime`、`uniqExact`、`multiIf`。StarRocks 和 Doris 都是 MySQL 方言族，这些一个都不认识。

更贵的是测试。视图契约测试和面板 SQL 全量核查跑在 chDB 上，那是与服务端同代的进程内 ClickHouse，CI 里不用起容器就拿到和生产相同的 SQL 语义。另两家没有等价物，换过去 CI 要么拉四五 GB 的镜像起容器，要么放弃这条保障。

## 开源边界：三家扣留的东西不一样

都是 Apache 2.0，都由一家公司主导开发，但留在商业版的能力正好相反：

| | 开源版给的 | 留在商业版或要外部组件的 |
|---|---|---|
| ClickHouse | 列级与行级授权、配额、审计系统表 | 云原生存储 SharedMergeTree（`ENGINE=SharedMergeTree` 在开源版报 Code 56）、自动扩缩、托管备份 |
| StarRocks | 存算分离（shared-data 模式）、多表 join、带查询改写的物化视图 | 列级与行级授权（开源经 Ranger 可得）、管理界面 |
| Doris | 列级与行级授权、存算分离（要 FoundationDB 等外部件） | 管理界面、托管服务 |

按「扣留的东西会不会影响我自建时能否把系统建对」这个判据，ClickHouse 扣留的是运维便利，StarRocks 扣留的是治理能力，Doris 几乎没扣留。要打两处折扣：ClickHouse 的 SharedMergeTree 有架构后果，开源版只能做冷数据分层，不只是省事；而 ClickHouse 核心是公司自持没有基金会兜底，StarRocks 和 Doris 的核心分别在 Linux Foundation 和 Apache 软件基金会名下，那条线更难往回挪。

治理归属上 Doris 最干净：Apache 顶级项目。StarRocks 的商业方今年六月刚改名并转向 AI agent 方向，开源版将来拿到什么取决于那家公司的取舍。

## 存算分离：Doris 的 cloud 模式是什么

Doris 3.0 的存算分离代码是商业方从自家云产品捐回社区的，配置项 `deploy_mode = "cloud"` 的名字随之带过来，本地机房接 MinIO 或 HDFS 一样能用。架构上数据下沉到对象存储，元数据搬进独立的 Meta Service，后面是一个 FoundationDB 集群，再加一个 Recycler 回收已删文件。核心卖点是计算组：多组 BE 共享一份数据，查询走一组、导入走另一组。

代价是重。官方手工部署文档的生产最小配置是 FoundationDB 3 台、Meta Service 3 节点、FE 3 节点、BE 1 台起，没有单容器或 compose 形态。一体集群和存算分离集群之间不能原地切换，要另起一套搬数据。

对照 StarRocks 的 shared-data 模式：元数据留在 FE 内存，不需要 FoundationDB，官方 quick start 就是一份 compose 三个容器（FE、CN、MinIO）。两家取舍不同，Doris 让 FE 几乎无状态但多运维一个大件，StarRocks 部署轻很多但 FE 仍有状态。这一段是我对两家文档的解读，两家都没有正面写这句。

## 分层结论

**单机用 ClickHouse。** 先是能力：负载形状落在它最强的那一格，可合并聚合状态没有等价物。再是形态与成本：单进程、镜像最小、常驻内存最低，列级与行级授权原生，Parquet 从 HTTP body 直灌，chDB 让测试和生产同一套方言。如果你的 SQL 已经在它上面，没有任何理由动。

**集群用 Doris 或 ClickHouse。** 两家都把治理能力留在开源版。Doris 天生分布式且归 Apache 基金会；ClickHouse 集群是 Keeper 加副本表，照文档配，但核心公司自持。选哪个看到那天手里有多少方言存量、运维班底熟哪套。

**日常分析处理用 DuckDB。** 夜间管道就地把大表压成 mart 这个角色它最称职。它是嵌入式库，没有「连接用户」的概念，能打开文件就是全部权限，所以不坐 serving 位置。chDB 在测试里的角色是同一逻辑的另一面：嵌入式引擎的价值在进程内，不在网络另一端。

**StarRocks 不在任何一层。** 它输给 Doris 的地方是列行授权缺席和商业方转向，而迁移成本与 Doris 完全相同。它唯一的独占优势是存算分离部署最轻，只有「必须存算分离且运维人手极少」这一种处境会让它回到候选。

## 一个差点写成「Doris 丢数据」的坑

Doris 测到一半，Stream Load 返回 `Status: Success, NumberLoadedRows: 1`，表里却查不到那行，重启后也没有。我差点写成 Doris 的持久化问题。查下去是：FE 对 Stream Load 回 307，Location 指向 BE 注册的地址 `127.0.0.1:8040`，与 FE 端口映射到哪无关。而我的宿主机上 StarRocks 的 allin1 也在跑，占着 8040。于是发给 Doris 的数据全灌进了 StarRocks，两边都报成功。

这是 all-in-one 这种单容器形态的共性坑，不是 Doris 独有。两台同时跑时，要么从容器内灌，要么只让一台占 8040。教训是：任何「返回成功但结果不见了」的现象，先怀疑请求到底送到了谁那里。

## 什么时候这个结论不适用

- 你的看板 SQL 还没写，或者已经在 MySQL 方言上：迁移成本那条不成立，Doris 和 ClickHouse 单机打平，Doris 多送多表 join 和更好的物化视图。
- 你从第一天就需要存算分离且运维人手极少：StarRocks 的三容器 shared-data 是最轻的入场票。
- 你的治理模型是库里有原文靠权限挡：StarRocks 开源版的视图纪律或 Ranger 成本要重新算，另两家不受影响。
