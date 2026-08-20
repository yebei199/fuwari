---
title: "一次例行镜像升级:14 个组件各自带来了什么"
published: 2026-08-20
description: "每日镜像漂移扫描报了 14 个可升级组件,逐个核对 release notes 后分两批部署。这篇按组件整理各自的新功能与修复,并记录过程中撞出来的两个意外收获。"
tags:
  - Docker
  - 镜像升级
  - 自建服务
  - 运维
category: 技术实践
draft: false
---

自建基础设施上跑着二十来个容器化服务,镜像版本全部以 tag 或 digest 形式 pin 在 compose
文件里,由 CI 每天扫一遍上游 registry,发现落后就推一条通知。这次通知报了 13 个可升级,
临部署前重新实测又多出 1 个,最终一次提交升了 14 个。

升级前把每个 minor 版本的 release notes 都过了一遍,确认没有破坏性变更和存储迁移,然后
分两批部署:无状态服务先行,压着四个数据库的 infrastructure 栈殿后,每个服务部署后立刻
验证容器健康和镜像实际运行身份。

## 各组件的变化

### Qdrant v1.18.3 → v1.19.0

这次升级里内容最多的一个:

- 新增 TurboQuant 4-bit 量化和 memory tier(cold / cached / pinned 三档),都是可选配置,
  不改配置则行为不变
- strict mode 的 `max_resident_memory_percent` 弃用,由新的 global quota API 接替
- 修复了 S3 snapshot 的路径穿越漏洞
- OpenAPI 移除了已弃用的旧版 search 端点。如果有客户端还在调旧的 `/points/search`,
  升级前要先迁移;我们仓库内没有这样的调用方,直接升

无存储迁移,滚动升级即可。

### Tuwunel(Matrix 服务端)v1.8.2 → v1.9.0

原计划按扫描结果升 v1.8.3,部署当天上游发了 v1.9.0,评估后直接一步到位:

- 修补了多个联邦(federation)安全披露
- 修复推送通知的投递与重试机制,以及 v1.8.3 引入的 LDAP 登录损坏
- 每账户 push ruleset 上限 1 万条(只在增长时强制)
- 首次启动会做一次性数据库迁移,执行四次全列扫描修复历史版本留下的潜在损坏,启动时间
  会明显变长。部署时要把这段慢启动和"服务挂了"区分开
- 裸二进制用户注意 TLS 现在强制要求 CA bundle;官方镜像用户不受影响

### ntfy v2.26.3 → v2.27.0

- PostgreSQL 后端转正,去掉 experimental 标签
- 新增邮箱登录
- 模板引擎加了硬限制(模板不超过 32KB 等),自定义超大模板会被截断,常规部署无感
- 数据库迁移自动完成,还会顺带修复 v2.14 遗留的 user DB schema 问题

### Grafana 13.1.1 → 13.1.4

扫描报的目标是 13.1.3,实际发布链值得展开:13.1.2 含两个 Logs Table 修复和
CVE-2026-13438;13.1.3 是一个无代码变更的 rebuild 版,release body 为空,连 CHANGELOG
都没进;13.1.4 在部署前一天发布,含 CVE-2026-17183 修复。于是跳过扫描报的版本直接升
13.1.4。教训是扫描结果给的目标版本只是下限,动手前值得再看一眼最新发布。

### ClickHouse 26.7.2.59 → 26.7.3.19

纯 bug-fix patch,无新功能,但修的都是实打实的崩溃和内存问题:

- 轻量 DELETE 导致整表 query condition cache 失效的性能回归
- MergeTree 上 direct JOIN 因查询计划克隆共享可变对象导致的崩溃
- 读 Parquet DECIMAL 列时的越界内存破坏,和物化视图分区去重场景的越界读
- async insert 队列罕见的 use-after-free

### Infisical v0.162.15 → v0.162.21

六个小版本的功能迭代,无安全公告、无 schema 迁移:

- PAM 增强:Redis 账户类型、machine identity 接入、访问控制改进
- PKI:支持从 AWS Private CA 签发 CA 证书,KMIP 证书自动续期
- Secret rotation 新增 Cloudflare API token 和 R2 access key 轮换
- 大量界面迁移到 v3 组件,属翻新非行为变化

### redis-exporter v1.88.0 → v1.89.0

纯维护版:Redis 不支持 COMMANDLOG 时不再刷错误日志,附带 prometheus client 库升级。

### 七个 digest 重推

postgres(pgvector)、rabbitmq、docker-cli、searxng、zipline、sing-box、AFFiNE 基础镜像
七个是同 tag 换 digest:上游没有发新版本,只是重新构建了镜像,通常意味着基础镜像吃进了
安全修补。这类升级没有功能变化,但 digest pin 的仓库必须跟着动,否则新部署拉到的还是
旧构建。

## 过程里的两个意外收获

升级本身顺利,收获反而来自部署后的全量验证。

第一个:验证扫出 headscale 的 web UI 容器 headplane 已经停了 11 天。排查发现宿主机 11
天前重启过一次,其余容器都被 docker 按 `unless-stopped` 策略拉了回来,唯独它退出码是
128,被 docker 的恢复逻辑当成手动停止跳过了。没有任何东西告诉我们这件事。于是给每台
docker 主机装了一个每小时跑的本地自检 cron:从部署配置渲染出这台主机应跑的容器清单,
和本地 `docker ps` 对比,偏离就推通知。检查器自身出错也必须告警,静默失败的绊线比没有
绊线更糟。选择每台主机只查自己而没有做集中式巡检,是因为集中式意味着把能登录所有主机
的凭据放上某一台公网机器,代价不值。

第二个:升级完顺手清理旧镜像,单台主机回收了 43.6GB。digest pin 的仓库每次升级都会留
下完整的旧镜像层,而 `docker image prune` 没人记得跑。批量升级和镜像清理应该绑在一起。

## 这套流程的适用边界

单人维护、可以接受短暂停机的私有基础设施,数据库一批重启是可接受的;多人生产环境需要
再加灰度和回滚窗口。逐版本核对 release notes 的成本在组件数量到几十个时还付得起,再往
上就需要自动抓取 changelog 摘要了。
