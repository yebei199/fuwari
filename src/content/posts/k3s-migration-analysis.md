---
title: "k3s迁移分析"
published: 2026-06-20
description: "从 main-vps 当前自托管服务出发，分析从多组 Docker Compose 迁移到 k3s 的收益、难点和迁移顺序。"
tags:
  - "k3s"
  - "Kubernetes"
  - "Docker Compose"
  - "自托管"
category: 技术实践
draft: false
---

这次 main-vps 内存排查最初看起来只是一个资源问题：部署游戏后，Grafana 里的 `Non-container` 内存抬高，删掉游戏以后仍然维持在大约 1.6 GiB。实际检查下来，游戏 workload 已经不在 Docker 和 Kubernetes 里运行，真正还在占资源的是当时为了游戏部署拉起来的 `k3s.service`。

这件事更大的价值不是“k3s 为什么吃 1GB 内存”，而是逼着我重新评估：在一台 VPS 上自托管十几个到几十个服务时，继续维护多组 Docker Compose，还是付出这笔 k3s 管理税，换一个统一控制平面？

当前仓库里的 main-vps 服务大致是这样的结构：

- `infrastructure`：ClickHouse、PostgreSQL、Redis、RabbitMQ。
- `communication`：Tuwunel Matrix homeserver。
- `security`：Vaultwarden、Infisical。
- `monitoring`：VictoriaMetrics、Grafana、node-exporter、cAdvisor、volume-exporter。
- `general`：SearXNG。
- `affine`：AFFiNE 文档协作，依赖共享 Postgres/Redis。
- `authentik`：SSO/OIDC/MFA，依赖共享 Postgres/Redis。
- `lemmy`：Lemmy、pict-rs、Photon，依赖共享 Postgres。
- `forgejo`：Git 服务，依赖共享 Postgres。
- `ntfy`：推送通知服务。
- `meow-web`：单镜像 Web 应用，已有 `meow-web-k8s` shadow 迁移路径。
- `zipline`：图床/文件分享，核心上传数据走 R2。

这些服务已经不是“一个 compose 项目”能自然覆盖的规模。Docker Compose 仍然适合单机、单项目编排，但当服务数量继续增长时，管理割裂会越来越明显：服务状态分散在不同 compose stack、网络边界靠手动约定、入口路由靠额外配置、Secret 和 volume 生命周期需要每个服务单独想一遍。

## k3s 的 1GB 是管理税

这次只读检查里，`k3s.service` 的 `MemoryCurrent` 约 1.18 GiB。拆开看，它不只是一个业务进程，而是一整套 Kubernetes 控制面和节点运行时：

- API Server、scheduler、controller manager 和内置 datastore。
- k3s 自带 containerd。
- kubelet、CNI、Service controller。
- CoreDNS、Traefik、metrics-server、local-path-provisioner 等系统组件。

所以这 1GB 左右内存不是某个游戏残留，也不是异常泄漏，而是控制平面的基础成本。问题不应该是“能不能把数字压低到最好看”，而是这笔资源开销能不能换回足够多的管理收益。

如果只是跑两三个稳定服务，Compose 更轻，k3s 可能是过度设计。但在当前这种多服务自托管场景里，人的注意力和维护时间比 1GB 内存更贵。每天在不同目录里找 compose 文件、查 `.env`、改反代、判断哪个 volume 能删，这些才是长期成本。

## 迁移后的核心收益

第一层收益是统一控制平面。Compose 的状态天然分散，一个 stack 一个上下文；k3s 则把所有 workload 收到一个 API 下。`kubectl get pods -A`、`kubectl get ingress -A`、`kubectl get pvc -A` 可以一次看到全局状态。对几十个服务来说，这个全局视角本身就是生产力。

第二层收益是统一网络和服务发现。Compose 项目之间默认隔离，跨 stack 访问要靠 external network、host port 或手写约定。k3s 里所有服务都可以通过 Service DNS 访问，例如 `postgres.infrastructure.svc.cluster.local` 这类稳定名字。服务间依赖从“知道宿主机端口”变成“知道集群服务名”。

第三层收益是入口路由收敛。现在每个公网服务最终都要和 Cloudflare Tunnel、host port、反向代理配置发生关系。迁到 k3s 后，应用只声明 Ingress，Traefik 动态接收路由。Cloudflare Tunnel 可以更稳定地指向统一入口，而不是每加一个服务都重新思考本地端口和代理规则。

第四层收益是 ConfigMap/Secret。当前 `.env` 是部署事实来源，这在仓库里已经被 `ops` 管起来了，但服务多了以后，环境变量仍然容易变成散落的大表。Kubernetes 的 Secret/ConfigMap 至少能把运行时输入变成 API 对象，并通过 Deployment 引用，减少“配置在文件系统哪个目录”的认知负担。

第五层收益是探针和自愈。Compose 的 `restart: unless-stopped` 只能处理进程退出。进程还在但 HTTP 不响应、依赖未就绪、启动半死不活时，Compose 不会主动判断。Kubernetes 的 readiness/liveness/startup probes 可以把“进程存活”和“服务可用”分开，控制器会持续把实际状态拉回期望状态。

第六层收益是 Helm 和 GitOps 生态。很多复杂服务在 Compose 下要自己维护大量 YAML、初始化命令和升级细节；在 Kubernetes 下，成熟 chart 至少提供了一个可升级的社区基线。以后如果引入 ArgoCD 或 Flux，Git 仓库就能成为集群期望状态的同步源。

## 不是所有服务都应该同一天迁

当前最适合作为第一批迁移对象的是无状态或低状态服务。

`meow-web` 已经有 `meow-web-k8s` shadow 路径，是最好的试验对象。它的数据库仍然可以先用 Compose 里的共享 Postgres，K8s 侧只处理应用 Deployment、Service、Ingress、Secret 和一个小的 art cache PVC。这个服务的价值在于验证迁移流水线，而不是挑战最难的数据迁移。

`ntfy`、`SearXNG`、`Zipline` 也相对适合早期迁移。它们要么状态较小，要么核心数据不完全在本地 volume。例如 Zipline 的上传对象主要在 R2，本地 volume 更偏配置、主题和临时数据。SearXNG 的 cache 可以接受重建。

第二批可以考虑文件状态明确的应用，例如 Forgejo、Vaultwarden、Tuwunel、pict-rs。这类服务的难点不是 Kubernetes manifest，而是停机窗口、文件权限、volume tar/copy、恢复验证和回滚路径。它们可以迁，但每个都要有单独的备份和恢复演练。

最不应该先迁的是共享基础设施：PostgreSQL、ClickHouse、Redis、RabbitMQ、VictoriaMetrics、Grafana、Authentik。它们不是不能迁，而是影响半径太大。共享 Postgres 一动，AFFiNE、Authentik、Forgejo、Lemmy、Zipline 等依赖都会被牵连。Authentik 又是登录入口，迁移失败会扩大成所有接入 OIDC 服务的认证问题。

所以合理顺序应该是：

1. 先迁无状态/低状态应用，保持数据库和核心中间件仍在 Compose。
2. 再迁文件型 stateful 应用，每个服务独立做备份、PVC、权限和回滚。
3. 最后再评估共享数据库、中间件、监控和身份系统是否值得迁。

## 最大难点是状态，不是 YAML

Docker volume 和 k3s PVC 是两套存储。当前 main-vps 的业务状态仍在 Docker named volumes，例如：

- `database_postgres18_data`
- `database_clickhouse-data`
- `monitoring_vm-data`
- `monitoring_grafana-data`
- `social_tuwunel-data`
- `social_forgejo-git-data`
- `social_vaultwarden-data`
- `meow-web-art`

K3s 默认 local-path PVC 会落在 `/var/lib/rancher/k3s/storage/...`。这和 Docker 的 `/var/lib/docker/volumes/<name>/_data` 没有自动映射关系。迁移时必须按数据类型处理：

- 缓存类 volume 可以直接放弃或低风险复制。
- 普通文件 volume 可以停服务后 tar/copy 到 PVC，再校验 UID/GID 和应用启动。
- 数据库 volume 不建议直接复制，应该走 dump/restore、应用级备份或数据库原生复制。
- 监控历史数据要先判断价值，不一定值得迁全量历史。

这也是迁移计划里最需要克制的地方。把 manifest 写出来很快，把数据安全迁过去才是真工作。

## 第二个难点是镜像边界

K3s 支持 Docker/OCI 镜像格式，但不共享 Docker daemon 的镜像缓存。Compose 能看到的 `meow-web:latest`，k3s 默认看不到。仓库里的 `meow-web-k8s` 通过下面的路径解决：

```text
docker save | gzip | k3s ctr -n k8s.io images import -
```

然后在 Deployment 中使用 `imagePullPolicy: Never`。这适合本地构建、小规模部署和 shadow migration。

但如果服务继续变多，长期更稳的方式是引入私有 registry 或明确的镜像发布流程。否则每个本地构建镜像都要单独处理导入，部署链路会越来越重。

这里还包括自定义镜像服务，例如 AFFiNE、monitoring 里的自定义 exporter 和 dashboard 镜像。它们迁移到 k3s 时不能只改 Deployment，还要决定镜像如何构建、如何命名、如何进入 k3s/containerd，以及如何回滚。

## 第三个难点是入口和身份系统

当前很多服务的公网入口不仅是端口暴露问题，还绑定了 Cloudflare Tunnel、域名、Authentik OIDC、回调 URL 和 cookie 安全策略。迁到 k3s 后，Ingress 可以统一入口，但不会自动替你解决身份边界。

例如 Authentik 是下游多个服务的身份源。如果先迁 Authentik，失败会影响 Grafana、Forgejo、AFFiNE 等登录链路。更安全的做法是先让业务服务通过 k3s Ingress 暴露，但继续使用现有 Authentik；等入口模型稳定后，再决定 Authentik 本身是否迁移。

Cloudflare Tunnel 也要按阶段处理。早期可以保持 Cloudflare 指向原有 host port，只对单个服务做 shadow/cutover。等多个服务都进入 k3s 后，再把 Tunnel 收敛到 Traefik 的统一入口。

## 第四个难点是监控和备份要换模型

当前监控栈偏 Docker 视角：cAdvisor、node-exporter、VictoriaMetrics、Grafana、volume-exporter 主要围绕容器和 Docker volume。迁到 k3s 后，问题会变成：

- Pod、Deployment、PVC、Ingress 的状态如何采集。
- K8s containerd 的资源指标是否进入现有 VictoriaMetrics。
- Docker volume 面板如何过渡到 PVC 用量面板。
- rollout、restart、probe failure 是否进入 dashboard。

备份也一样。现有备份逻辑大量围绕 `docker exec postgres`、Docker named volume tar 包和 restic。迁到 k3s 后，需要重新定义：

- PVC 如何备份。
- 数据库是继续应用级 dump，还是引入 operator/backup job。
- 恢复时先恢复 Secret、PVC、数据库，还是先恢复 Deployment。
- 回滚是回到 Compose，还是回到上一个 K8s revision。

如果这些没有先设计，迁移只是在把风险从 Docker 目录搬到 Kubernetes namespace。

## 这 1GB 值不值

我的判断是：如果 main-vps 只是临时跑一个游戏，k3s 的 1GB 管理税不值。删掉游戏后停掉甚至卸载 k3s，是合理选择。

但如果目标是继续自托管更多服务，并把现在这些 Compose stack 的管理割裂收束起来，这 1GB 是有可能值得的。它换来的不是性能，而是统一控制平面、统一入口、统一服务发现、探针、自愈、Secret/PVC 抽象和更强的生态。

更现实的策略不是“一夜之间全迁”，而是把 k3s 当作新平台逐步接管：

1. 保留 Compose 里的基础设施和数据库。
2. 用 `meow-web-k8s` 验证部署、Ingress、Secret、PVC 和 cutover。
3. 迁移低状态服务，积累模板和回滚经验。
4. 为文件型服务补齐备份/PVC/权限验证。
5. 最后再讨论数据库、监控、Authentik 这类高影响服务。

如果后续确认 k3s 的管理收益不足，再停用它也不晚。重要的是不要把“空载 k3s 占 1GB”简单理解成浪费，也不要把“有 Kubernetes”简单理解成所有服务都应该马上迁。

真正的决策标准应该是：这 1GB 内存能不能减少日常维护中的割裂感、重复配置、手工路由、状态不透明和恢复不确定性。如果能，它就是管理平台的成本；如果不能，它就是应该关掉的空转服务。
