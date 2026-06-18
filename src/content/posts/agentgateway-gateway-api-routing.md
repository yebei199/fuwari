---
title: "Agentgateway 部署复盘：CRD、KUBECONFIG 和 Gateway API 路由"
published: 2026-06-19
description: "把 agentgateway 接到本地 Qwen 模型时，Helm CRD、k3s kubeconfig、Gateway API 和后端路由的关键坑。"
tags:
  - "agentgateway"
  - "Gateway API"
  - "Kubernetes"
  - "LLM"
category: 技术实践
draft: false
---

这次本地 AI 栈里，agentgateway 是三个业务服务中最像“基础设施”的一个。它表面上只是给 OpenClaw 和 Hermes 提供 OpenAI-compatible endpoint，实际上牵涉到 Helm、CRD、Gateway API、Service DNS、模型后端路由和健康检查。

最终部署出来的结构是：

- `agentgateway` controller 运行在 `agentgateway-system`。
- `agentgateway-proxy` 作为 Gateway data plane。
- `qwen3-chat` 和 `qwen3-embedding` 通过 `AgentgatewayBackend` 暴露。
- `/v1/chat/completions`、`/v1/models`、`/v1/embeddings` 由 HTTPRoute 分别路由。
- `local-ai` namespace 里提供一个 `ExternalName` service，业务服务只访问 `agentgateway.local-ai.svc.cluster.local`。

## 第一个坑：CRD 不能靠主 chart 顺手解决

一开始 agentgateway 卡在 CRD 相关问题上。解决方式不是把 YAML 手抄进仓库，而是把安装流程拆清楚：

- Gateway API 标准 CRD 单独安装。
- agentgateway 自己的 CRD 用 `agentgateway-crds` chart 安装。
- agentgateway controller/proxy 再用主 chart 安装。

这让部署顺序变得明确，也避免了主 chart 与 CRD 生命周期混在一起。后续升级时，CRD 是一个独立部署单元，不需要靠某个应用 manifest 的副作用。

这里的经验是：CRD 不是普通业务资源。依赖 CRD 的 chart 如果和 CRD 本身一起失败，排障会非常混乱。把 CRD 安装当成平台能力处理，后面的 Gateway、HTTPRoute、Backend 才有稳定前提。

## 第二个坑：Helm 在 k3s 上会悄悄找错集群

本地 `kubectl` 能用，不代表 `helm` 在 `ops` 生成的脚本里一定能用同一个 kubeconfig。实际遇到的问题是 Helm 回退到了默认的 `localhost:8080` 语义。

修复方式是在 generic Kubernetes app 的 deploy/verify 脚本里，当 `/etc/rancher/k3s/k3s.yaml` 存在时显式导出：

```sh
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
```

这个改动很小，但价值很高：它把 k3s 的真实 kubeconfig 位置收进部署器，而不是依赖调用者 shell 的偶然状态。所有后续 Helm 或 kubectl 操作都继承同一上下文。

## 第三个坑：controller rollout 不代表 data plane 已能路由

agentgateway 曾经在第一次部署检查时失败过：

```text
unable to forward port because pod is not running. Current status=Pending
```

原因不是配置一定错了，而是 health check 发生时 `agentgateway-proxy` Pod 还没 Ready。后来再次执行部署，controller、proxy、Gateway 和 Backend 都进入正常状态。

这个坑提醒我：网关系统至少有三层状态。

- controller Deployment 是否 rollout。
- proxy/data plane Pod 是否 Ready。
- Gateway/HTTPRoute/Backend 是否被控制器接受并编程完成。

只看第一层很容易误判。

## 路由设计

最终路由没有让每个业务服务直接知道两个模型后端，而是由 agentgateway 做统一入口。

`qwen3-chat` backend 负责：

```yaml
/v1/chat/completions: Completions
/v1/models: Passthrough
"*": Passthrough
```

`qwen3-embedding` backend 负责：

```yaml
/v1/embeddings: Passthrough
"*": Passthrough
```

HTTPRoute 再把不同 PathPrefix 指向不同 `AgentgatewayBackend`。这样 OpenClaw 和 Hermes 只需要配置：

```text
OPENAI_BASE_URL=http://agentgateway.local-ai.svc.cluster.local/v1
```

不需要知道 chat 和 embedding 分别在哪个 Service 上。

## 验证方法

这次最终确认 agentgateway 可用，不是只看 Helm release，而是同时检查：

- `agentgateway` controller `1/1 Running`。
- `agentgateway-proxy` `1/1 Running`。
- Gateway `PROGRAMMED=True`。
- 两个 `AgentgatewayBackend` 都 `ACCEPTED=True`。
- 访问 `http://192.168.31.33/v1/models` 返回 Qwen 模型列表。

最后一条尤其重要，因为它证明了 Gateway API、agentgateway backend、Service DNS、qwen3-chat 后端都串起来了。

## 可复用结论

Agentgateway 这类 LLM 网关不应该被当成“一个 Helm chart”来看。更稳的理解是：

1. CRD 是平台前置能力。
2. controller 是配置解释器。
3. proxy 是流量数据面。
4. Gateway API 资源是声明式路由。
5. 模型服务才是真正的上游。

验证时也应该覆盖这五层。少看一层，就可能把部署成功误判成业务可用。
