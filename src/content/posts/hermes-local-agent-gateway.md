---
title: "Hermes 接入本地模型网关：简单服务也要收紧配置边界"
published: 2026-06-19
description: "Hermes Agent 在本地 Kubernetes 中接入 agentgateway 的配置边界、部署验证和后续改进点。"
tags:
  - "Hermes"
  - "Kubernetes"
  - "agentgateway"
  - "LLM"
category: 技术实践
draft: false
---

Hermes 是这次三个业务服务里部署最顺的一项，但它仍然暴露了一个容易被忽略的问题：服务越简单，越要把配置边界写清楚。

最终 Hermes 的 Kubernetes 形态是：

- 镜像：`nousresearch/hermes-agent:latest`
- 启动参数：`gateway run`
- API 端口：`8642`
- 数据目录：`/opt/data`
- 模型入口：`http://agentgateway.local-ai.svc.cluster.local/v1`
- 模型名：`qwen3-30b-a3b-instruct-2507`

它不直接连 `qwen3-chat`，也不直接连 `qwen3-embedding`。所有模型访问都通过 agentgateway 统一入口。

## 第一个经验：配置归属要在 dry-run 阶段就固定

早期实现里，`API_SERVER_ENABLED` 曾经被当成 dry-run note 挂到不正确的服务链路上，后来才移动到 Hermes 自己的配置里。

这类错误不会一定导致部署失败，但会让部署意图变脏：读 dry-run 输出的人会误以为某个变量属于另一个服务。对于由 `ops service deploy <name>` 驱动的部署系统，dry-run 输出本身就是契约的一部分，不能把配置项随手塞到“看起来能显示”的地方。

最终 Hermes 的环境变量收口在自己的 Deployment 里：

```yaml
API_SERVER_ENABLED: "true"
API_SERVER_HOST: 0.0.0.0
API_SERVER_KEY: <secret>
OPENAI_API_KEY: <secret>
OPENAI_BASE_URL: http://agentgateway.local-ai.svc.cluster.local/v1
OPENAI_MODEL: qwen3-30b-a3b-instruct-2507
```

这让服务边界很清晰：Hermes 负责暴露自己的 API server，agentgateway 负责模型路由，Secret 负责密钥来源。

## 第二个经验：cluster-local endpoint 比公网暴露更适合第一阶段

Hermes 这次没有接 Cloudflare，也没有暴露公网入口。它只在 `local-ai` namespace 里通过 ClusterIP 暴露：

```yaml
service/hermes 8642/TCP
```

模型调用走：

```text
agentgateway.local-ai.svc.cluster.local
```

这个设计的好处是部署阶段先验证内部依赖：

- Hermes 容器能启动。
- PVC 能挂载。
- Secret 能注入。
- agentgateway 的 OpenAI-compatible endpoint 能被集群内服务访问。

公网访问、认证策略、入口流量治理可以放到下一阶段处理。否则第一轮部署失败时，很难判断问题来自应用、模型网关、DNS、TLS 还是公网入口。

## 第三个经验：镜像拉取慢不一定是故障，但要和启动失败区分

Hermes 镜像体积约 1.2GB，实际拉取耗时接近一分钟。这段时间里命令没有立即输出，很容易让人误判为卡住。

这次的处理方式是等待同一个 `ops` 进程返回，而不是绕过 `ops` 手工操作 Kubernetes。最后事件显示镜像成功 pulled，Pod created，container started，Deployment rollout 成功。

这里的经验是：真实部署中要区分三类等待：

- 镜像下载等待。
- Pod 调度或 PVC 绑定等待。
- 应用启动失败导致的 CrashLoop。

它们看起来都像“等很久”，但处理方式完全不同。Hermes 属于第一类，OpenClaw 属于第三类。

## 验证方法

Hermes 部署命令是：

```sh
cargo run -q -p ops -- service deploy hermes --yes
```

部署后复核：

- `hermes` Pod `1/1 Running`。
- Restart count 为 0。
- `hermes-data` PVC `Bound`。
- `hermes` Deployment `1/1 AVAILABLE`。
- agentgateway `/v1/models` 返回 Qwen 模型列表。

最后一条不是 Hermes 自身健康检查，但它验证了 Hermes 所依赖的模型入口可用。

## 后续应该补的验证

Hermes 这次部署成功，但从工程质量看还有一个明显后续项：应该补一个 Hermes 自身的服务级健康检查，而不是只依赖 Deployment rollout 和模型网关检查。

如果 Hermes 镜像提供稳定的 health endpoint，就应该接入 readiness/liveness probe；如果没有，则至少在 `ops` 里增加一个能确认 API server 端口响应的 cluster-local check。

## 可复用结论

Hermes 的经验不是“部署很简单”，而是简单服务也应该遵守三个边界：

1. 每个环境变量必须属于正确服务。
2. 第一阶段优先验证 cluster-local 依赖，不急着暴露公网。
3. rollout 成功后还要补服务级检查，避免只证明容器活着。

这类边界写清楚，后续再叠加认证、入口和公网访问时才不会把问题混在一起。
