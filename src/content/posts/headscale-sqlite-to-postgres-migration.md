---
title: "把 Headscale 从 SQLite 迁到 Postgres 后，我重新理解了迁移验证"
published: 2026-06-24
description: "一次 Headscale 状态库迁移复盘：为什么要停机、怎样设计回滚，以及 pgloader 导入不能只看命令是否成功。"
tags:
  - "Headscale"
  - "Postgres"
  - "数据迁移"
  - "运维"
category: 技术实践
draft: false
---

这次迁移的目标并不复杂：把已经跑起来的 Headscale 主数据库从 SQLite 迁到共享 Postgres，同时把 ACL policy 切到 database 模式，让管理界面可以直接维护 ACL。

真正麻烦的地方不在“配置一个 Postgres 连接串”，而在状态迁移这件事本身。Headscale 是 tailnet 控制面，里面有用户、节点、preauth key、API key 和策略数据。迁移失败不是页面打不开这么简单，最坏会影响所有节点重新连回控制面。所以这次没有追求在线迁移，而是接受维护窗口，把流程设计成：先演练、再停机、失败自动回滚、最后用业务对象计数和真实 CLI 输出验证。

## 为什么要从 SQLite 换到 Postgres

SQLite 对一个小型自托管 Headscale 完全够用。它简单、少依赖、容易备份。迁移到 Postgres 不是为了性能优化，而是为了运维一致性：

- 其他有状态服务已经在走统一的 Postgres 备份链路。
- 未来迁移机器时，数据库和卷可以用同一套 restic/PG dump 流程处理。
- Headplane 管 ACL 更适合让 Headscale 使用 database policy。

这个选择也有代价。Headscale 对 Postgres 的支持不是为了高吞吐场景而存在，迁移后多了一层数据库依赖。对于只有几台机器的 tailnet，如果没有统一备份和迁移需求，继续用 SQLite 反而更省心。

## 迁移脚本必须先能失败

一开始最重要的设计不是导入，而是失败路径。

迁移命令被收进 `ops service headscale-migrate-postgres`，默认 dry-run，只有带 `--yes` 才会真实执行。真实执行前先备份旧 compose/config，再同步新的 Headscale 配置；迁移过程中一旦出错，就把旧配置恢复回去，并按原 SQLite 配置重新启动 Headscale 和 Headplane。

停机切换前还会把原数据卷打 tar 包，包含 SQLite 主库和 WAL/SHM 相关文件。这样即使 Postgres 侧导入成功但启动验证失败，也可以回到迁移前的配置和卷状态。对控制面服务来说，这种“能确定退回去”的能力比少停机几分钟更重要。

## 第一个坑：不要依赖远端 apt 状态

最早的方案在迁移时到远端安装工具。真实跑起来以后，远端包源签名问题直接让迁移失败。这个失败和 Headscale、SQLite、Postgres 都无关，却足以打断维护窗口。

后来把 pgloader 包进一个专用容器镜像，由迁移脚本按需构建。这样迁移工具链和宿主机包源状态解耦，脚本也更接近“同一套输入产生同一套行为”。这类状态迁移脚本越靠近生产，越应该减少对远端临时环境的假设。

## 第二个坑：镜像架构也是迁移依赖

换成容器后又踩到架构问题：现成 pgloader 镜像在目标机器架构上不能执行。这个错误很直接，但说明了另一个事实：迁移依赖不只是数据库和配置，也包括 CPU 架构、镜像 manifest、entrypoint 行为这些平时不太显眼的细节。

最终做法是在目标机器上用 Debian slim 构建本地 pgloader 镜像。它不是最优雅的方式，但足够可控：基础镜像支持目标架构，构建命令写进迁移脚本，之后每次迁移都走同一条路径。

## 第三个坑：Headscale CLI 不等于离线校验器

演练阶段原本想用同版本 Headscale 容器对临时 Postgres 执行 `users list` 和 `nodes list`。这个想法看起来很好：既然最终服务要用 Headscale 读库，那就让 Headscale 自己读一次。

实际失败了。离线容器里的 CLI 默认会尝试连接 Headscale Unix socket，而不是单纯打开数据库读表。也就是说，这个命令验证的是“能不能连到正在运行的 Headscale 服务”，不是“迁移后的数据库是否可读”。

这一步后来改成两层验证：

- 演练库阶段，用同版本 Headscale 先跑 `configtest`，确保 Postgres schema 由 Headscale 自己初始化。
- 数据导入后，比对 SQLite 和 Postgres 里的关键表行数。
- 生产切换后，再启动真正的 Headscale 服务，用容器内 CLI 跑 `health`、`users list`、`nodes list`。

离线校验和在线校验的边界要分清。一个命令在容器里能运行，不代表它验证的是你以为的那一层。

## 第四个坑：pgloader 成功不等于业务数据进库

最有价值的坑来自 pgloader。

第一次导入时，pgloader 命令本身没有明显失败，Headscale `configtest` 也通过，但比对计数发现关键表全是 0：用户 0、节点 0、preauth key 0、API key 0。这个结果非常危险，因为如果只看“命令退出码”和“服务能启动”，很可能会把一个空控制面当成迁移成功。

修正分两步。

第一步，让 Headscale 先初始化 Postgres schema，再让 pgloader 导入数据。不能让 pgloader 自己猜 Headscale 的目标 schema，因为最终运行时要服从 Headscale 当前版本的迁移逻辑。

第二步，pgloader 不能用过于粗暴的 data-only 模式，而要明确告诉它：不要 drop，不要建表，不要建索引，只 truncate 现有表、导入数据、重置 sequence。这样它会把 SQLite 数据塞进 Headscale 已经创建好的表结构里。

后来还给 pgloader 加了 summary 输出。这个改动很小，但排障价值很大：成功时能看到每张表导入了多少行，失败时也能看到错误停在哪张表。最后一次成功导入时，summary 清楚显示关键表都进了数据，和 SQLite 计数一致。

## 验证口径要贴近业务对象

这次迁移没有把“Postgres 里有表”当成成功，也没有把“容器启动了”当成成功。真正的验证口径是这些业务对象是否还在：

- 用户数量一致。
- 节点数量一致。
- preauth key 数量一致。
- API key 数量一致。
- Headscale 健康检查通过。
- Headscale 能列出用户和节点。
- 已有服务器节点仍在线。
- 管理界面能启动并连接 Headscale。
- 备份 dry-run 会同时覆盖 Postgres dump 和原 Headscale 数据卷。

这里保留原 volume 很重要。迁到 Postgres 后，主数据库不再是 SQLite，但数据卷里仍有控制面密钥、缓存和迁移前备份材料。备份策略如果只看数据库，会漏掉恢复 Headscale 所需的关键状态。

## database policy 不是“顺手改个字段”

这次一起把 ACL policy 切到 database 模式，是因为管理界面需要通过 Headscale API 管 ACL。之前 file 模式下没有可用 policy 文件，页面会提示 ACL 不可用。

但 policy 模式切换要和数据库迁移放在同一个受控流程里。原因是它改变的是控制面行为，不只是 UI 展示。迁移后初始策略要保持原有语义，不应该在数据库切换同时引入新的访问限制。也就是说，数据库迁移和 ACL 收敛可以同一维护窗口完成，但验证时要分别确认：控制面数据还在，管理界面不再因为 file policy 缺失而报错。

## 这次沉淀下来的模式

这次迁移最后沉淀成一套可以复用的状态服务迁移模式：

1. 真实操作只能走一个受管入口，默认 dry-run。
2. 停机前备份旧配置和原始数据卷。
3. 先把目标数据库初始化成应用当前版本期望的 schema。
4. 再把源数据导入目标 schema，而不是让通用工具猜结构。
5. 演练库和生产库使用同一套导入流程。
6. 对比业务对象计数，不只看工具退出码。
7. 启动真实服务后再跑在线 CLI 和 UI/HTTP 验证。
8. 备份链路随迁移一起更新，不能留到“以后再说”。

这套模式不只适用于 Headscale。任何小型自托管服务，只要状态里有身份、节点、密钥、权限或连接关系，都应该用类似的思路处理。迁移脚本不是把数据搬过去就结束，它还要证明搬过去的是同一套业务状态，并且在失败时能可靠地回到原点。

## 什么时候不该这么做

如果只是一个个人实验环境、没有统一备份系统、节点可以随时重建，那么 SQLite 到 Postgres 的迁移可能不值得。迁移脚本、回滚、演练库、pgloader 镜像和备份接入都会增加复杂度。

这次之所以值得，是因为目标不是“更高级的数据库”，而是“更统一的恢复能力”。一旦这个前提不存在，简单的 SQLite 文件备份反而是更好的工程选择。

最后的经验很朴素：状态迁移的难点不是写出那条导入命令，而是知道什么才算成功。只有当用户、节点、密钥、策略、服务健康、管理界面和备份链路都被同一套流程验证过，迁移才算真的结束。
