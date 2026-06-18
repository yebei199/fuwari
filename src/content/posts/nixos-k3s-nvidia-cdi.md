---
title: "NixOS 上的 k3s GPU 部署：别只盯着 device plugin"
published: 2026-06-19
description: "一次本地 AI Kubernetes 平台部署中，NVIDIA GPU 资源注册、CDI、runc 路径和模型下载代理踩坑的复盘。"
tags:
  - "NixOS"
  - "k3s"
  - "NVIDIA"
  - "Kubernetes"
category: 技术实践
draft: false
---

这次本地 AI 栈部署最早不是卡在模型服务，也不是卡在业务应用，而是被平台预检挡住：

```text
nvidia.com/gpu allocatable resource is required for qwen3-chat
```

表面看是 NVIDIA device plugin 没起来，实质上是 NixOS、k3s、containerd、NVIDIA runtime、CDI 这几层没有形成一个稳定闭环。只要节点没有把 GPU 暴露成 Kubernetes allocatable resource，后面的 Qwen3 chat 服务就算 manifest 正确，也不会被认为具备部署条件。

## 第一个坑：device plugin 不是唯一答案

一开始按传统路径尝试 NVIDIA device plugin，但它一直处于异常状态，节点没有注册 `nvidia.com/gpu`。这类问题容易让人继续追 device plugin 日志，但在 NixOS 上还要同时考虑：

- NVIDIA container toolkit 生成的 CDI 描述是否已经存在。
- k3s 启动顺序是否晚于 CDI generator。
- containerd runtime 是否能在 k3s 的 systemd 环境里找到底层 runtime。
- kubelet 能不能通过 device plugin 或 CDI 插件看到设备。

最后走的是 CDI 路线：在 NixOS 的 `local-k3s.nix` 里启用 `nvidia-container-toolkit`，让 `nvidia-container-toolkit-cdi-generator.service` 先于 `k3s.service`，再通过 `generic-cdi-plugin` 把 `/var/run/cdi/nvidia-container-toolkit.json` 暴露给 Kubernetes。

资源名也因此从传统的：

```yaml
nvidia.com/gpu: "1"
```

变成了实际注册出来的：

```yaml
nvidia.com/gpu-all: "1"
```

这里的经验是：平台预检应该检查集群真实暴露的资源名，而不是假设某个行业默认名一定存在。这次 `ops` 里的 `local-k8s-platform` 预检也跟着改成检查 `nvidia.com/gpu-all`，否则平台明明可用，部署器仍然会误判失败。

## 第二个坑：k3s 的 PATH 和交互 shell 不一样

部署前还修过一个更底层的问题：NVIDIA runtime 里底层 `runc` 不能只写成 `"runc"`。在交互 shell 里能找到，不代表 k3s/containerd 的 systemd 环境能找到。

修复方式是把 runtime 配置里的底层 runc 改成 Nix store 里的绝对路径：

```nix
runtimes = ["${pkgs.runc}/bin/runc"]
```

这个问题的价值在于提醒自己：NixOS 上服务进程的运行时环境非常干净，很多“我在 shell 里能运行”的东西，对 systemd service 并不存在。凡是 runtime、hook、helper binary，能写绝对路径就不要依赖 PATH。

## 第三个坑：GPU 注册成功不等于模型能顺利启动

`qwen3-chat` 真正跑起来还依赖两类配置。

第一类是 GPU 调度：

```yaml
runtimeClassName: nvidia
resources:
  limits:
    nvidia.com/gpu-all: "1"
  requests:
    cpu: "4"
    memory: 18Gi
    nvidia.com/gpu-all: "1"
```

第二类是模型文件准备。最初使用 `llama-server -hf` 拉 Hugging Face 模型，下载慢且代理行为不够可控。后来改成 initContainer 里显式执行 `curl`，挂同一个 PVC，并设置大小写两套代理变量：

```yaml
HTTP_PROXY: http://10.42.0.1:7897
HTTPS_PROXY: http://10.42.0.1:7897
http_proxy: http://10.42.0.1:7897
https_proxy: http://10.42.0.1:7897
NO_PROXY: 127.0.0.1,localhost,::1,10.42.0.0/16,10.43.0.0/16,.svc,.cluster.local
```

并用 `curl --continue-at -` 支持断点续传，先写 `.part`，完成后再 rename 成最终 GGUF 文件。这样模型下载、代理、缓存和服务启动就分开了：下载失败时失败在 initContainer，模型服务不会带着半截文件启动。

## 验证方法

这次最终可用的证据不是“命令返回 0”，而是几层一起成立：

- `local-k8s-platform` 预检通过。
- 节点 allocatable 里有 `nvidia.com/gpu-all`。
- `qwen3-chat` Pod 使用 `runtimeClassName: nvidia` 且 `1/1 Running`。
- `qwen3-embedding` 与 `qwen3-chat` 共享模型 PVC，各自服务正常。
- 经 agentgateway 调用 `/v1/models` 返回 Qwen GGUF 模型列表。

## 可复用结论

本地 AI Kubernetes 平台的第一性问题不是“能不能写一个 Deployment”，而是平台能否稳定提供三件事：

1. 真实可调度的 GPU 资源名。
2. 可重复、可观察、可断点续传的模型下载路径。
3. 不依赖交互 shell 环境的 runtime 配置。

后面的服务部署能否顺利，基本取决于这三件事有没有先被平台层收口。
