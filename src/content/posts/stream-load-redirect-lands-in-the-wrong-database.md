---
title: "Stream Load 返回 Success，数据却进了另一台库：单容器 OLAP 的 307 重定向坑"
published: 2026-09-02
description: "同一台机器上跑 StarRocks 和 Doris 的单容器镜像，发给 Doris 的 Stream Load 静默灌进了 StarRocks，两边都报成功。记一次差点误判成数据丢失的排查。"
tags:
  - StarRocks
  - Apache Doris
  - Docker
  - 排错
category: 技术实践
draft: false
---

## 现象

在 Doris 的 all-in-one 容器上测 Stream Load：

```
$ printf 'D1,delta,3.5,7\n' | curl --location-trusted -u root: \
    -H 'Expect:100-continue' -H 'column_separator:,' \
    -XPUT -T - http://127.0.0.1:8031/api/scm/sku/_stream_load
{"Status":"Success","NumberLoadedRows":1,"TxnId":160,...}

$ mysql -h127.0.0.1 -P9031 -uroot -e 'SELECT count(*) FROM scm.sku'
3
```

灌之前 3 行，返回成功 1 行，灌之后还是 3 行。等十秒还是 3。重启容器还是 3。同一张表用 `INSERT INTO` 写一行，立刻可见，重启后也在。

我第一反应是 Doris 的事务提交与发布是异步的，重启把未发布的事务回滚了。差点就这么写进结论。

## 排查

先排除卷挂错：FE 元数据目录 324K、BE 存储目录 79M，都落在具名卷上，重启后基础数据和行级策略都在。持久化没问题。

再看 Stream Load 到底去了哪。FE 收到 Stream Load 不自己处理，回一个 307 让客户端去找 BE：

```
$ curl -i --max-redirs 0 -u root: -H 'Expect:100-continue' \
    -XPUT -T d.csv http://127.0.0.1:8031/api/scm/sku/_stream_load
HTTP/1.1 307 Temporary Redirect
Location: http://root:@127.0.0.1:8040/api/scm/sku/_stream_load
```

Location 是 `127.0.0.1:8040`，这是 BE **在 FE 里注册的**地址，与我把 FE 的 8030 映射到宿主机 8031 没有任何关系。客户端在宿主机上，`--location-trusted` 老老实实跟到宿主机的 `127.0.0.1:8040`。

而宿主机的 8040 归谁？

```
$ docker ps --format '{{.Names}} {{.Ports}}' | grep 8040
starrocks  0.0.0.0:8040->8040/tcp
doris      0.0.0.0:8041->8040/tcp
```

同一台机器上还跑着 StarRocks 的 allin1 容器，它占着 8040。而我为了做授权对比，在 StarRocks 里也建了一张同名同结构的 `scm.sku`。于是：

```
$ mysql -h127.0.0.1 -P9030 -uroot -e 'SELECT sku FROM scm.sku'   # 这是 StarRocks
A1 A2 B1 C1 C9 D1
```

三次「丢失」的行全在 StarRocks 里。Doris 的 FE 说去找 BE，客户端去了 StarRocks 的 BE，StarRocks 的 BE 发现库表都在，欣然收下，报 Success。Doris 那边 FE 记了一个事务号，然后再没人来。

## 为什么会这样

这不是 Doris 的 bug，也不是 StarRocks 的。两家是同一血脉（StarRocks 从 Doris 分叉），Stream Load 的协议一样：FE 只做路由，真正收数据的是 BE，客户端必须能直连 BE 注册的地址。

单容器镜像为了让 FE 和 BE 在容器内互相找到，把 BE 注册成 `127.0.0.1`。这在容器内没问题，但一旦客户端在宿主机，`127.0.0.1:8040` 就变成了「宿主机上谁占着 8040」。只跑一台时恰好是它自己，跑两台时就是先到先得。

更糟的是失败模式：不是连接被拒，不是报错，是另一台库替你收了，返回成功。如果两边表结构不一样，StarRocks 会报列不匹配，你还能发现；表结构一样时，什么信号都没有。

## 怎么办

- 两台单容器引擎同时跑时，从容器内灌：`docker exec <容器> curl http://127.0.0.1:8030/...`，这时 `127.0.0.1` 解析在容器的网络命名空间里，找到的是它自己的 BE。
- 或者只让一台占宿主机的 8040。
- 单容器镜像的 BE 注册在 `127.0.0.1`，意味着它不是集群的种子。将来要扩容是重新部署，不是加节点。

## 教训

任何「返回成功但结果不见了」的现象，先确认请求到底送到了谁那里，再去怀疑事务、持久化、异步发布。我把 `--max-redirs 0` 加上看 Location 只花了十秒，此前猜异步提交花了十分钟。
