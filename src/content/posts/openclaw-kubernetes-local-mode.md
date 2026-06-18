---
title: "OpenClaw 容器化踩坑：rollout 成功不等于服务可用"
published: 2026-06-19
description: "OpenClaw 在 Kubernetes 中因缺少 local gateway 配置反复退出，最终通过 ConfigMap 和探针修正的经验。"
tags:
  - "OpenClaw"
  - "Kubernetes"
  - "容器化"
  - "LLM"
category: 技术实践
draft: false
---

OpenClaw 是这次部署里最典型的“rollout 通过但服务不可用”的案例。

第一次执行：

```sh
cargo run -q -p ops -- service deploy openclaw --yes
```

命令返回成功，Deployment 一度显示 successfully rolled out。但复核 `local-ai` namespace 时，OpenClaw Pod 已经变成 `Error`，Deployment 也不再 Available。

日志里真正的原因很直接：

```text
Missing config. Run `openclaw setup` or set gateway.mode=local (or pass --allow-unconfigured).
```

这说明容器镜像能启动，不代表它已经具备 Kubernetes 中需要的应用配置。

## 第一个坑：CLI 默认配置不适合无交互容器

OpenClaw 的错误信息暗示它默认期望先执行 `openclaw setup`。这在个人开发机上可以接受，但在 Kubernetes 里不是一个好前提：

- Pod 启动应该是幂等的。
- 配置应该来自 manifest、Secret、ConfigMap 或挂载卷。
- 不能要求运维人员进入容器交互执行初始化。

最终修复是添加 `openclaw-config` ConfigMap，并把配置挂载到：

```text
/home/node/.openclaw/openclaw.json
```

核心内容是：

```json
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "port": 18789
  }
}
```

`mode=local` 解决缺配置问题，`bind=lan` 让 Kubernetes Service 能访问 Pod，而不是只监听 loopback。

## 第二个坑：Service 能连到 Pod，应用也要监听对地址

容器里监听 `127.0.0.1` 时，进程本身看起来启动了，但 Kubernetes Service 从 Pod 网络访问不到。OpenClaw 日志在修复后也明确给出提示：绑定非 loopback 地址时要确认认证配置。

这也是为什么配置里不能只写 `gateway.mode=local`，还要写：

```json
"bind": "lan"
```

同时 OpenClaw 通过 Secret 注入：

```yaml
OPENCLAW_GATEWAY_TOKEN
OPENAI_API_KEY
OPENAI_BASE_URL=http://agentgateway.local-ai.svc.cluster.local/v1
OPENAI_MODEL=qwen3-30b-a3b-instruct-2507
```

也就是说，OpenClaw 对外是自己的 gateway，对内仍然把 agentgateway 当作 OpenAI-compatible provider。

## 第三个坑：rollout 不能替代健康探针

OpenClaw 第一次“成功 rollout”后又退出，说明单靠 `kubectl rollout status` 不够。Deployment 在短时间内达到过可用状态，不代表应用持续健康。

修复里补了三类探针：

```yaml
startupProbe:
  httpGet:
    path: /healthz
    port: http
livenessProbe:
  httpGet:
    path: /healthz
    port: http
readinessProbe:
  httpGet:
    path: /readyz
    port: http
```

这样 Kubernetes 不再只根据容器进程是否存在做判断，而是通过 OpenClaw 自己的 HTTP 健康端点判断能不能接流量。

## 验证方法

修复后重新执行：

```sh
cargo run -q -p ops -- service deploy openclaw --yes
```

结果里 `openclaw-config` 被创建，Deployment 重新 rollout。随后复核：

- OpenClaw Pod `1/1 Running`。
- Restart count 为 0。
- 日志出现 `gateway ready`。
- `local-ai` namespace 下 OpenClaw Deployment `1/1 AVAILABLE`。

这次才算真正部署成功。

## 可复用结论

OpenClaw 这个问题的价值不在于某个配置文件路径，而在于容器化应用的一般规则：

1. 交互式 setup 必须转成声明式配置。
2. 服务监听地址必须匹配 Kubernetes 网络模型。
3. rollout 只是部署状态，不能代表应用健康。
4. 应用存在健康端点时，应该显式接入 startup、liveness 和 readiness probe。

以后遇到“rollout 成功但业务不可用”，第一反应不该是重启，而应该是查日志、查探针、查进程监听地址。
