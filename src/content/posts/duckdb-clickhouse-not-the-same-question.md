---
title: "DuckDB 和 ClickHouse 不是同一道题：一次选型推演里被推翻的三个判断"
published: 2026-09-01
description: "从「chDB 和 DuckDB 差多少」问起，一路问到「看板该把数据放哪」。推演过程中我有三个判断被推翻，而真正把方案逼到唯一解的，是 S3 读取延迟和维度笛卡尔积这两个反驳。"
tags:
  - "OLAP"
  - "DuckDB"
  - "ClickHouse"
  - "数据看板"
  - "选型"
category: 技术实践
draft: false
---

这篇不是实战记录，是一次选型推演。起点是个很窄的问题——chDB 和 DuckDB 在能力上差多少——推到最后发现，问题本身就问偏了：这两个东西从来不在同一道题里。

推演过程中我有三个判断被推翻。留下这篇的主要理由不是最后那张选型表，而是那三个被推翻的地方，它们标出了这个话题里最容易踩的坑。

## 起点：一个问偏的问题

最初的对比很容易得出「chDB 全面落后于 DuckDB」的印象：体积几百 MB 对几十 MB，语言绑定 DuckDB 覆盖到 WASM 而 chDB 主要是 Python，DataFrame 互操作前者零拷贝且成熟，社区和文档量级更是不用比。

结论没错，但推理路径是错的。chDB 要解决的从来不是「ClickHouse 部署太麻烦」，而是「我需要一个库，不是一个服务」——这个需求 ClickHouse server 再简单也满足不了。它唯一不可替代的场景只有一个：线上跑 ClickHouse，本地或 CI 需要完全相同的 SQL 语义、函数库和聚合状态。这时候用 DuckDB 意味着维护两套 SQL，那才是真麻烦。

夹缝之外它确实打不过 DuckDB。但那个夹缝是真实存在的。

## 被推翻的判断之一：DuckDB 没有 server 形态

我原本的说法是「需要 server 的那一刻 DuckDB 就退出比较了，它压根没有 server 形态」。这个说法已经过时。

DuckDB 官方在 2026 年 5 月发布了 **Quack 协议**：HTTP/TCP 之上跑 `application/duckdb` 序列化，默认端口 9494，支持多写者并发。客户端一条 `ATTACH 'quack:host'` 就连上远程的 DuckDB 进程。

但官方公告里的几个数字，比协议本身更能说明它现在的位置：

- 8 线程时写入吞吐 5,434 tx/s，同时官方明确写着 DuckDB「beyond 8 parallel threads 撞到当前限制」；
- 授权回调的默认行为是 permissive，用官方原话说是「just says yes to everything」，认证只是启动时生成的随机 token，没有租户隔离的文档；
- 不支持高可用与复制，「thinking about adding a replication protocol」还在 roadmap 上；
- 不建议直接暴露公网，需要 nginx 加 SSL 反代；
- 生产版计划随 DuckDB v2.0 在 2026 年秋发布。

传输性能倒是实打实的亮眼：6000 万行 / 76GB CSV 传输 4.94 秒，对比 Arrow Flight 的 17.40 秒和 PostgreSQL 的 158.37 秒。但那是**数据搬运**的胜利，不是**并发服务**的胜利，两者容易混。

所以准确的说法是：Quack 堵上了「DuckDB 没有网络接口」这个缺口，但它现在的位置是「小团队分析仓库」，不是「高并发实时分析服务」。

## 被推翻的判断之二：ClickHouse 运维复杂

我用「ClickHouse 集群运维不是省心活」当过选 DuckDB 路线的理由。这条站不住。

单机 ClickHouse 装起来非常简单：一个 `docker run`，静态二进制，没有 JVM 没有外部依赖，默认配置可用，HTTP 和原生 TCP 端口开箱即有。跟 Elasticsearch、Druid、Pinot 比，它简单得不像同一个物种。

反过来讲，「自托管 DuckDB」那条路零件更多：Quack 服务进程、nginx 反代、DuckLake 的 catalog 数据库、对象存储、备份。论装起来，单机 ClickHouse 比这套简单。

单机 ClickHouse 真正的成本不在「装」，在「用对」，坑集中在四处：

**内存边界。** 一条 ad-hoc 的大 `GROUP BY` 能把整个进程 OOM 掉，连带所有其他查询一起死。需要显式设 `max_memory_usage`、`max_bytes_before_external_group_by`，最好再配 per-user 配额。DuckDB 在这方面落盘更自动，是它实打实的优势。

**写入批量。** 逐行 insert 会撞上 `Too many parts` —— 后台 merge 跟不上产生的小 part，服务随之劣化。要么上游攒批，要么开 `async_insert`。这个坑的症状出现得很晚，跑了两周才炸。

**表设计不可逆。** `ORDER BY` 排序键在建表时定死，选错了查询就永远慢，只能重建表重灌数据。这不算运维，但它是最贵的错误，因为发现时数据已经在里面了。

**Mutation 的代价。** `ALTER TABLE ... UPDATE/DELETE` 是异步 mutation，会重写受影响的 part，大表上吃几小时 IO 和大量临时磁盘空间是常态。

这四项都是调参和设计的成本，有明确的上手曲线，学一次就过去了。真正麻烦的 Keeper 集群、副本同步、分片 rebalance，只有在需要高可用或单机装不下时才出现。

所以「运维复杂」不该成为选 DuckDB 路线的理由。真正的理由应该是别的：数据本来就以 Parquet 躺在对象存储上、要嵌进应用进程里、要 scale-to-zero 的无状态计算。

## DuckDB 的服务端生态：让别人当 server

顺着 Quack 往下查，发现一件比协议本身更有意思的事——DuckDB 生态确实长出了服务端能力，但没有一条路线是「把 DuckDB 做成守护进程」。

**塞进一个已经是 server 的东西里。** pg_duckdb 是 Postgres 扩展，Postgres 已经有 wire protocol、连接管理、认证、RBAC、MVCC、复制这些脏活，DuckDB 只负责向量化列式扫描。思路很务实：你缺的从来不是查询引擎，是引擎外面那一圈，与其给 DuckDB 补一圈，不如借现成的。

**把状态推给存储层。** DuckLake 的关键设计是元数据不放在对象存储的文件里，而是进一个真正的事务型数据库（v1.0 支持 SQLite、PostgreSQL、DuckDB 自身作为 catalog）。多写者的 ACID 由 catalog 承担，计算侧仍是一堆互不相识的无状态进程。它给的是批量提交式的并发写——官方的流式方案是 data inlining，默认阈值 ≤10 行就刷到对象存储，这个量级说明它面向 trickle 写入，不是 Kafka 级摄入。

**付钱。** MotherDuck，DuckDB 核心团队自己的托管服务。

这个形状我认为是清醒的判断。正面硬碰 ClickHouse 的服务器阵地，是进入一个已经很拥挤的品类——ClickHouse、Druid、Pinot、StarRocks、Doris 都各自独立地收敛到了同一个形状：本地列存加排序键、缓存层、可合并聚合状态、权限、复制。这个形状不是谁的专利，是这类问题的解本身长这样。避开这一仗，DuckDB 才保住了自己最强的那一面。

## 集群这道题，DuckDB 反而更复杂

如果确实要横向扩展，DuckDB 路线不只是拼装工作量的问题，是结构上的：**它不能把一条查询拆到多台机器上执行**。Quack 是「远程连到一个 DuckDB 进程」，不是「N 台机器协同算一条查询」。

所以它的横向扩展只有一个含义——同一份只读能力的多个副本。而给 OLAP 建集群最常见的动机恰恰是「单查询超过一台机器的算力」，这个需求它一点忙都帮不上。

要自己搭的话，查询路由与健康检查、认证授权、准入控制与资源配额、小文件合并与快照清理、查询日志与指标，每一项都得自己写，而 ClickHouse 全都内建。DuckLake 的 catalog 若要高可用，你还得把那个 Postgres 做成高可用的——绕一圈还是在运维一个带复制的数据库。

公平地说，无状态副本的故障模型确实更干净：节点挂了就摘掉，没有状态要恢复、没有副本要追平。但这个优势属于「无状态计算 + 对象存储」这个架构，不属于 DuckDB——多个互不相识的 ClickHouse 节点直读 S3 同样干净，还省掉上面那张清单的大半。

## 被推翻的判断之三：有看板就必须上 server

这条要收窄。只读、少数人看的内部看板，DuckDB 是能撑的，Evidence、Rill 这类 BI 工具本身就内嵌 DuckDB。

真正的分水岭不是「有没有看板」，而是**权限和脱敏要不要在数据层强制执行**。

在 BI 工具里做脱敏是显示层的，只要有人拿到直连凭证、或者用了导出功能，就全绕过去了。数据层的权限不管从哪个客户端进来都绕不过——这才是「必须上 server」的真正论据。

ClickHouse 在这块的能力是齐的：行级策略按条件过滤行，列级 GRANT 让某些列查都查不到，quota 限制单用户的查询数和内存上限，query_log 做审计。实践上最好用的姿势是只暴露视图不暴露底表：

```sql
CREATE VIEW orders_masked AS
SELECT id, concat(left(phone, 3), '****', right(phone, 4)) AS phone, amount
FROM orders;

GRANT SELECT ON db.orders_masked TO analyst;  -- 底表不授权
```

不过「只能选 ClickHouse」也略绝对。数据量在 Postgres 管得住的范围内时，Postgres 的 RBAC 和 RLS 比 ClickHouse 更成熟，配上 pg_duckdb 接管分析查询的执行，权限用 Postgres 的、性能用 DuckDB 的。分界大概在：要扫的数据大到必须靠 MergeTree 索引和预聚合才跑得动，才轮到 ClickHouse。

## 真正把方案逼到唯一解的两个反驳

前面都还是能各自成立的方案。把它逼到唯一解的，是看板场景下的两个反驳。

**Grafana 连不上一个库。** 它是独立进程，需要一个网络数据源。这比权限更基础地把人推向 server。ClickHouse 有官方 Grafana 数据源插件，写原生 SQL、支持时间宏和模板变量；自写的 ECharts 前端还能直接吃它 HTTP 接口的 `FORMAT JSONCompact`，返回的 `meta` + `data` 结构几乎就是 ECharts 的 dataset 格式，能省掉一整层后端 API。

那退一步，让 pg_duckdb 去扫湖上的 Parquet，权限走 Postgres 的 RLS，看起来成立。于是第一个反驳来了。

**反驳一：S3 撑不起交互式看板。** 瓶颈不是带宽是延迟。读一个 Parquet 至少两次往返——先取 footer 拿元数据，再按 row group 取列块。一个面板查询碰 50 个文件就是上百次往返起步，并行也压不到理想值。8 个面板 30 秒刷一次，体验直接毁掉。请求数计费也容易被忽略，高频刷新的看板，GET 请求的账单可能超过存储本身。

这不是 pg_duckdb 的锅，ClickHouse 直读 S3 上的 Parquet 会遇到一模一样的问题——这是「计算存储分离 + 冷对象存储」的固有代价。区别在于 ClickHouse 内建了两层对策：filesystem cache 把 S3 上的 MergeTree part 缓存到本地盘，物化视图让看板要的聚合结果在写入时就算好。

那就预聚合，服务层不碰 S3：湖只用于加工，聚合结果落成 Postgres 表供看板查询。于是第二个反驳来了。

**反驳二：维度笛卡尔积爆炸，不可能预计算全部。** 这条成立，但「预聚合」不等于「枚举维度组合」，混在一起就会得出预聚合没用的结论。

正确的做法是 rollup 不是 cube。建一张聚合到最细公共粒度的表就够了：10 亿行原始事件聚合到 `(day, country, device, product)` 大概是 1000 万行，任何过滤或分组只要是这四个维度的子集，都在这张表上扫。压缩来自折叠事件粒度，组合数不参与爆炸。

但 rollup 确实有断掉的地方：`count(distinct)` 和分位数不可加，你没法把按天的 UV 加起来得到按月的 UV。ClickHouse 对这个有直接答案——**可合并的聚合状态**。存 `uniqState(user_id)`、`quantileState(latency)` 这样的中间态而不是最终数字，查询时用 `uniqMerge` 按任意粒度合并，`AggregatingMergeTree` 加物化视图把这套做成自动维护的。存 HyperLogLog 的中间状态，于是 distinct 和分位数也能 rollup 了。这正是 DuckDB 没有等价物的地方。

而更关键的一点是：**预聚合本来就不是主策略**。ClickHouse 应付任意维度组合的第一手段是原始表本身扫得够快——稀疏主键索引、跳数索引、projection。预聚合只给最热的那几个面板加速。

这才是 S3 路线的死穴：它没有「原始扫描够快」这个后备。预聚合覆盖不到的查询，就得回去扫湖，而扫湖意味着几百次往返。两个反驳指向同一个结论——看板这类负载需要的是本地列存加索引加可合并聚合状态，三样凑齐的只有 ClickHouse。

诚实地说，ClickHouse 也做不到「任意维度组合都毫秒」。排序键只有一个，过滤条件不落在其前缀上时主键索引失效，退化成全表扫。跳数索引和 projection 能补，但都要针对特定查询模式设计。准确说法是「绝大多数组合亚秒级」。

## 顺带澄清两个身份问题

**DuckDB 不是「嵌入式的 ClickHouse」。** ClickHouse 的性能模型建立在「数据是我写的」之上，MergeTree、排序键、后台 merge 都预设它拥有存储。DuckDB 的重心恰恰是查询它不拥有的数据：你的 Parquet、你的 DataFrame、attach 过来的 Postgres。它的自我定位从一开始就是「分析版的 SQLite」。

ClickHouse 的嵌入版有现成的，就叫 chDB——而它恰恰证明了「把 ClickHouse 缩小」不等于「做出好用的嵌入式分析库」。体积、绑定生态、DataFrame 互操作上的短板，根源都在它继承了「存储归我」这套假设，而嵌入式场景通常是「数据在别处」。

**DuckDB 也不是 Polars 的另一形态。** Polars 是计算库，DuckDB 是数据库。重叠的是单机列式计算这一段，但 DuckDB 还有持久化、ACID、目录、`ATTACH`、扩展系统——它拥有状态。反过来 Polars 的表达式 API 是可编程、可组合、可单测的代码对象，SQL 干同样的事只能拼字符串。

一个能直接证伪的检验：Grafana 能接 DuckDB（经 pg_duckdb 或 Quack），但永远接不上 Polars。也正因为不拥有数据，Polars 这条线上从来没有出现过「服务化」这个命题。

对 pandas 才是真正的上位替代，这一条没什么争议。

## 收敛后的选型

| 场景 | 选择 |
| --- | --- |
| 本地分析、嵌进代码、Notebook | DuckDB |
| Python 管道里做数据变换 | Polars |
| 只读看板、人少、无脱敏需求 | DuckDB + BI 工具 |
| 多人 + 权限 + 脱敏，数据量中等 | Postgres + pg_duckdb |
| 多人看板 + 大数据量 / 要实时 | ClickHouse |
| 高并发对外服务 / 流式摄入 | ClickHouse |
| 单条查询超过单机算力 | ClickHouse |
| 线上是 ClickHouse，本地要同构 SQL | chDB |

如果真要落地 ClickHouse，有几件事最好一开始就做对：只暴露视图不暴露底表，否则后面想加脱敏几乎收不回来；配 quota 和 settings 约束，多人共用时某个分析师把机器 OOM 掉是迟早的事；排序键在建表时想清楚；写入务必攒批；不需要高可用就别建集群，单机加定期 `BACKUP TO S3` 是完整方案。

## 边界

这是一次推演，不是压测报告。几件事需要自己核实：

Quack 是否已随 DuckDB v2.0 转正——官方说计划在 2026 年秋，也就是现在这个时间点前后。ClickHouse 存算分离的开源现状——SharedMergeTree 据了解是 Cloud 的闭源实现，开源版走 S3 磁盘加 zero-copy replication，两者不等价。ClickHouse 的 JOIN 优化器和内存默认值的当前行为，近几个版本一直在调整。Grafana 的 DuckDB 或 Quack 社区数据源插件成熟度，我没有验证过，不建议押在上面。

关于性能我没有给任何倍数。公开跑分对 schema、查询形态、数据是否有序极度敏感，脱离实际负载引用会误导。真要比，就拿自己的数据和那几条真实的看板查询，在同一台机器上各跑一遍，半天的工作量，结论比任何 benchmark 都可信。

参考的官方材料是 [Quack 协议公告](https://duckdb.org/2026/05/12/quack-remote-protocol)（2026-05-12）和 [DuckLake v1.0 发布说明](https://ducklake.select/2026/04/13/ducklake-10/)（2026-04-13）。
