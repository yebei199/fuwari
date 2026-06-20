---
title: "一次真实 k3s 迁移后的经验"
published: 2026-06-20
description: "从 SearXNG、ClickHouse 和 meow-web 的生产迁移复盘 shadow deploy、备份、切流和工具反哺。"
tags:
  - "k3s"
  - "Kubernetes"
  - "生产迁移"
  - "自托管"
category: 技术实践
draft: false
---

前一篇文章分析过 main-vps 从 Docker Compose 迁到 k3s 是否值得。那时讨论的是平台选择、迁移顺序和状态风险。这一次不再是分析，而是真正把 `searxng`、`clickhouse` 和 `meow-web` 迁到了 k3s，并且完成了生产切流。

最终结果是好的：三个服务都完成备份、部署、切流和验证。`search.cryptorust.uk` 与 `meow.cryptorust.uk` 通过 Cloudflare Tunnel 指向 k3s Traefik，ClickHouse 的 `9030` 和 `9363` 端口也由 k3s Service 接管。

但这次迁移最有价值的部分不是“成功了”，而是中间暴露出来的几个具体问题：计划里看起来很完整的流程，到了生产环境里仍然会被 Kubernetes 的细节、SSH 传输行为、LoadBalancer 接管延迟和镜像启动参数打断。迁移计划只能降低风险，真正把系统推到可运行状态的是一边执行、一边把失败沉淀回工具链。

## 先把迁移动作做成可重复命令

这次迁移没有手工 SSH、没有直接 `kubectl`，所有远端操作都通过仓库里的 `ops` 命令执行。这个约束一开始看起来麻烦，但生产迁移时很值。

迁移前先补了三个层面的能力：

- k3s app 配置可以描述 cutover 元数据：旧 Compose stack、旧服务名、Cloudflare hostname、k3s tunnel service、是否需要 volume migration。
- SearXNG 和 ClickHouse 有各自的 Kustomize manifests、Secrets、PVC、rollout 和健康检查。
- `ops service backup create` 支持 `searxng`、`clickhouse` 和 `meow-web`，迁移前可以先生成一致性快照。

这样生产执行就不是“人在服务器上敲一串命令”，而是：

```text
ops service backup create <service> --yes
ops service deploy <service-k8s> --yes
ops service cutover <service-k8s> --yes
ops service verify <service-k8s>
```

这个形式的好处是，每次失败都会回到同一条路径上修工具，而不是修一段只在当天存在的临时命令。后面几次现场修复都能马上变成提交，下一次 deploy/cutover 直接复用。

## 备份不是迁移前的装饰动作

生产迁移前，三个服务都先做了备份：

- `searxng`：备份 cache volume。
- `clickhouse`：停止 Compose ClickHouse 后备份 `database_clickhouse-data`。
- `meow-web`：备份数据库 dump 和 `meow-web-art` volume。

这里最关键的是 ClickHouse。它不是简单的 Web 服务，cutover 时要停止旧 Compose 容器，把 Docker volume 再次打成带时间戳的 tarball，然后通过 loader pod 复制到 `clickhouse-data` PVC。这个流程意味着 ClickHouse 迁移天然有停机窗口，不能假装它和无状态服务一样。

也正因为有备份，后面 ClickHouse 切流时遇到短暂端口接管失败，判断空间就清晰得多：数据已经在切流脚本里备份并复制，Compose 容器已经停止，接下来要验证的是 k3s Service 是否接管端口，而不是慌忙怀疑数据是否丢了。

我的经验是，迁移前备份不要只写在计划里，要变成和 deploy/cutover 同级的一等命令。否则越到生产现场，越容易把备份当成“应该已经做过”的心理安慰。

## shadow deploy 要避免抢生产端口

SearXNG 和 meow-web 的 shadow deploy 相对简单：先在 k3s 里启动 Deployment、Service、Ingress，Cloudflare Tunnel 还不切过去，生产流量仍然在 Compose 上。

ClickHouse 不一样。Compose 版本已经占用宿主机 `9030` 和 `9363`，k3s shadow 服务如果一开始就用 LoadBalancer 绑定同样的端口，必然冲突。因此 ClickHouse manifest 先用 ClusterIP：

- shadow deploy 阶段只验证 StatefulSet、PVC、镜像和集群内部状态。
- cutover 阶段先停止 Compose ClickHouse。
- volume 复制完成后再把 Service patch 成 LoadBalancer。
- 最后检查 `127.0.0.1:9030`、`127.0.0.1:9363` 和 `/ping`。

这个设计把“应用能不能在 k3s 跑起来”和“生产端口什么时候交给 k3s”分开了。对有固定宿主机端口的 stateful 服务，这个分离很重要。否则所谓 shadow deploy 实际上只是另一种形式的生产抢占。

## 第一类故障：rollout 静默不是服务没动

第一次部署 SearXNG 时，`ops` 返回的是 SSH 等待条件超时。表面看像网络问题，但 k3s 基线验证又是通的。

后来确认，远端命令卡在 `kubectl rollout status`。当 rollout 长时间没有输出时，SSH 通道在本地表现为等待超时，真正的 Kubernetes 失败原因没有被带回来。

这个问题的修复不是“把超时调大”这么简单，而是把 rollout 变成短周期轮询：

- 每 15 秒跑一次 `kubectl rollout status --timeout=15s`。
- 失败时输出 `kubectl get pods -o wide`。
- 总超时到达后输出 pod logs、events 和 describe。

这次修复之后，错误从模糊的 SSH timeout 变成了明确的 Kubernetes 状态：`deployment "searxng" exceeded its progress deadline`，Pod 是 `CrashLoopBackOff`。

这条经验很直接：生产部署工具不能只执行命令，还要保证失败信息能穿透回来。否则你排查的不是服务，而是排查工具为什么什么都不告诉你。

## 第二类故障：Kubernetes Service 环境变量会污染应用启动参数

SearXNG 的 Pod logs 里真正的根因是：

```text
Error: Invalid value for '--port': 'tcp://10.43.225.227:8080' is not a valid integer.
```

这不是镜像坏了，也不是 ConfigMap 写错了，而是 Kubernetes 的 service links 行为。集群里有一个名为 `searxng` 的 Service，于是 Kubernetes 往 Pod 里注入了类似 `SEARXNG_PORT=tcp://...` 的环境变量。SearXNG 启动命令把 `SEARXNG_PORT` 当作端口参数读走，结果期望整数却拿到了 service URL。

第一次修复是把 Service 从 `searxng` 改成 `searxng-http`，避免生成同名环境变量。但这还不够，因为旧 Service 已经在集群里存在，旧 ReplicaSet 也没有因为 Service 改名自动重建。

真正稳的修复是在 Pod spec 里设置：

```yaml
enableServiceLinks: false
```

这会从根上禁止 Kubernetes 把 Service 信息注入容器环境变量。之后 SearXNG 新 ReplicaSet 正常启动，`ops service verify searxng-k8s` 能拿到页面内容。

这个坑很适合记下来：如果一个应用本身使用 `*_PORT` 这类环境变量，Kubernetes 默认 service links 可能会和它撞名。尤其是从 Compose 迁到 Kubernetes 时，Compose 环境里没有这类自动注入，问题只会在 k8s 上出现。

## 第三类故障：LoadBalancer 接管端口需要等待

ClickHouse cutover 的流程整体执行到了最后，但第一次切后 TCP 检查失败：

```text
/dev/tcp/127.0.0.1/9030: Connection refused
```

当时 Compose ClickHouse 已经停止，k3s Service 也已经被 patch 成 LoadBalancer。20 秒后重新执行：

```text
ops service verify clickhouse-k8s
```

结果 `9030`、`9363` 和 `/ping` 全部通过。

这说明问题不是 ClickHouse 没起来，而是 k3s LoadBalancer 从 Service 更新到宿主机端口实际可用之间有短暂延迟。这个延迟在正常情况下不长，但如果 cutover 脚本只检查一次，就会把暂态误判成失败。

后续修复是给 cutover post-check 增加短重试：TCP 和 HTTP 检查最多重试约 60 秒。普通 verify 仍然保持直接检查，只有切流后的 post-check 容忍端口接管延迟。

这条经验也很通用：切流后的健康检查需要理解控制面的传播延迟。检查太松会掩盖问题，检查太硬会制造误报。对 k3s LoadBalancer 这种由控制器接管宿主机端口的路径，短重试比单次检查更符合实际。

## meow-web 证明了简单服务的价值

和 SearXNG、ClickHouse 相比，meow-web 的迁移最顺。它已经有 k3s shadow 路径，本地镜像通过 `docker save | k3s ctr import` 进入 k3s/containerd，Deployment rollout 后 `/api/health` 返回 `{"status":"ok"}`，cutover 时 Cloudflare Tunnel 从旧端口切到 Traefik。

这类服务的意义不是“技术上最有挑战”，而是给迁移链路提供稳定参照物。当 SearXNG 和 ClickHouse 出问题时，meow-web 能证明 k3s、Traefik、Cloudflare Tunnel 和 `ops` 的大部分路径是可用的，排查范围自然缩小到服务自身差异。

迁移顺序里应该保留这种低风险服务。它们让平台变化先被验证，而不是一上来就把所有不确定性压到数据库和身份系统上。

## 工具链被生产反向打磨

这次迁移过程里产生了几类修复：

- 备份别名：`searxng` 和 `clickhouse` 不是独立 managed service，需要映射到父 stack 才能定位目标机器。
- rollout 输出：长时间无输出会让 SSH 层先报错，需要周期性输出和失败诊断。
- rollout 诊断：失败时必须包含 pod logs、events 和 describe。
- SearXNG manifest：Service 命名和 `enableServiceLinks: false` 都要固定成测试约束。
- cutover post-check：ClickHouse 端口接管需要短重试。

这些修复看起来分散，但共同点是：生产迁移不是只修改应用 manifest，也是在修改运维系统对失败的表达能力。

如果没有把这些修复提交回仓库，下一次迁移还会重新踩一遍。如果把它们变成测试和工具行为，下一次迁移的风险就会下降。

## 这次迁移后的几个结论

第一，备份、部署、切流、验证必须是四个独立阶段。尤其是 stateful 服务，不要把“部署到 k3s 成功”理解成“可以切流”。

第二，shadow deploy 要尽量不碰生产入口。能用 ClusterIP 就先用 ClusterIP，真正需要宿主机端口时放到 cutover 阶段。

第三，Kubernetes 的默认行为也会成为迁移风险。`enableServiceLinks` 这种平时容易忽略的字段，在某些镜像上会直接决定应用能不能启动。

第四，部署工具的错误输出是生产能力的一部分。只看到 SSH timeout 没有意义；看到 pod logs、events 和 describe，才可能快速收敛到根因。

第五，cutover 健康检查要区分“服务永久失败”和“控制面传播延迟”。短重试不是放松标准，而是承认系统状态从声明到生效需要时间。

第六，先迁低风险服务并不浪费时间。它们能验证平台路径，给复杂服务提供对照组。

## 迁完以后还没结束

这次迁移完成后，Compose 里的旧服务已经被停止并由 k3s 接管，但后续还有几个清理动作不应该和生产切流混在同一天做：

- 确认备份保留策略和 ClickHouse 迁移 tarball 路径。
- 观察一段时间的 k3s Pod restart、PVC 用量和入口流量。
- 再决定如何移除或归档旧 Compose 服务定义。
- 评估 SearXNG secret 是否需要轮换。
- 继续处理仓库已有的 `rsa 0.10.0-rc.18` audit 残留风险。

迁移当天最重要的是把服务稳定切过去。清理旧世界可以晚一点做，因为清理动作本身也有风险。

这次最大的体感是：k3s 迁移不是把 Docker Compose YAML 翻译成 Kubernetes YAML。真正的工作是把生产里的隐含约束一个个显式化：谁占端口，谁持有状态，谁负责入口，失败时看什么，回滚依赖什么。

当这些约束能被 `ops` 命令、测试和 manifests 表达出来，迁移才从一次性操作变成可复用的工程能力。
