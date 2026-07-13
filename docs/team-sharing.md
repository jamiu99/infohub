# 团队共享

> 上级：[overview.md](overview.md) · 决策：[decisions.md](decisions.md#adr-013-团队服务采用单实例单团队和共享入组-token) · 本地数据接口：[data-interface.md](data-interface.md)

团队共享的目标是让多个 infohub 客户端复用采集结果、减少同一来源的重复请求，同时继续把数据落成普通文件。团队服务不采集微信公众号，也不接触任何登录凭据。

## 边界

```text
本机 SourceAdapter → 本地 Raw / Article / SQLite
                         │
                         └─ 非阻塞 outbox → HTTPS 团队服务
                                                │
其他成员客户端 ← 增量 pull / cursor ← Article + contribution
```

- 桌面 App 仍是唯一采集端；默认手动刷新、全局串行和本机账号限流不变。
- 团队后端是独立、自托管项目 `infohub-team-server`，一个实例只代表一个团队。
- 默认服务地址为 `https://home.agent-wiki.cn:18038`；正式客户端只接受 HTTPS。
- 本地文章先成功落盘，再写同步 outbox；团队服务不可用不能阻塞或回滚本地采集。
- 只同步经过 allowlist 的 Source 元数据和归一化 Article；Raw 与微信 cookie、token、fingerprint、浏览器 partition/session 永不上传。

## 入组与设备凭据

1. 服务端通过环境变量配置唯一共享 `TEAM_TOKEN`。
2. 客户端首次加入只提交服务地址、`TEAM_TOKEN`、成员显示名和设备名。
3. 服务端验证后生成随机、不透明的设备 token，并只在响应中返回明文。
4. 客户端不生成、不指定设备 token；本机使用 Electron `safeStorage` 保存。
5. 后续同步请求使用 `Authorization: Bearer <device-token>`，共享 `TEAM_TOKEN` 不持久化。

如果系统 `safeStorage` 不可用，客户端拒绝把团队设备 token 以明文落盘，本次入组会明确失败。微信公众号账号池仍有历史明文 fallback，属于另一项待修问题。

MVP 假设成员互相信任。细粒度权限、限时邀请、审计、复杂撤销和端到端加密是极低优先级未来能力。

## 去重与“我的 / 团队”

服务端不把文章绑定给单一 owner：

- Source 用类型和 canonical key 去重：微信公众号使用 `fakeid`，RSS 使用规范化 feed URL。
- Article 用 canonical Source + `externalId` 去重，不信任不同客户端的本地 Article ID。
- `article_contributions` 单独记录哪些设备在何时采到同一篇文章。
- “我的”表示当前设备贡献过；“团队”表示服务器上的全部 Article。
- 第二个成员上传同一篇文章只新增 contribution，不复制正文。
- `read` / `archived` 是个人本地状态，不上传为团队公共状态。
- 取消本地订阅时，纯本地文章按原行为删除；带服务端 `remoteId` 的团队副本继续留在“团队”，并保留个人阅读/归档状态。

团队 pull 回来的文章仍写入本地 Article 文件，并带可重建的来源标记；外部消费者因此可以继续从文件系统读取团队数据。纯团队文章后来被本机真实采到时，必须补记本机 contribution，不能被本地 `seen_items` 提前跳过。

## 共享来源与采集责任

团队订阅、成员个人关注和采集负责人是三个独立概念。服务端 MVP 已提供可解释的静态分配模型：

- 新 Source 默认分配给首次上传它的设备。
- 服务端可把团队 Source 轮询均分给当前设备，也允许手工重新分配。
- 设备开始团队采集任务前申请短租约；同一 Source 同时只能有一个有效租约。
- 租约只防止团队客户端重复执行，不改变本机账号池和小时配额。
- 第一版不做智能调度或后台自动爬取。

当前桌面 v0.2.1 只接入文章 push/pull，还没有展示 assignment 或执行 lease 的“刷新我的任务”入口。因此 A/B 分配现在可通过服务端 API 管理，但要真正让桌面只采自己的任务，还需要下一阶段客户端接入；不能仅凭已有 API 宣称重复请求已经完全避免。

## 自托管与 HTTPS

服务默认监听 `127.0.0.1:18038`。配置 TLS 证书和私钥时可直接提供 HTTPS；否则只能在 loopback 后通过可信反向代理终止 TLS。FRP 只做端口转发时不会自动产生 HTTPS，公网入口必须提供与域名匹配且客户端信任的证书。

服务端数据目录保存 SQLite 元数据、团队 Article 文件和迁移版本。备份整个数据目录即可恢复，不依赖外部数据库或对象存储。

## 同步协议

- `POST /api/v1/join`：共享 token 首次入组并签发设备 token。
- `GET /api/v1/status`：读取实例、团队和当前设备信息。
- `POST /api/v1/sync/push`：批量幂等上传 outbox 事件。
- `GET /api/v1/sync/pull?cursor=`：按单调游标拉取增量变化。
- Source / device / assignment / lease 使用独立的 `/api/v1` 资源接口。

协议必须限制请求体大小、校验字段与 URL、拒绝未知敏感字段，并保证重复 push 不产生重复 Article。

客户端在入队和发送前按同一 v1 限制预检。损坏、超限或被服务端以永久 4xx 拒绝的事件写入 `team/quarantine/`；批次会二分定位坏项，合法事件继续上传。RSS URL 若内嵌账号密码，或查询参数名疑似 token/secret/password/API key/签名，则整条 Source 不上传且事件被隔离。

## 当前实现状态

- 桌面端：设置弹窗内的加入/退出/状态、设备凭据、可恢复历史补传、outbox/ack/隔离、定时与手动 push/pull，以及主阅读栏“我的 / 团队”视图已实现。
- 服务端：单团队入组、设备/Source/Article/contribution、幂等事件、cursor、assignment/rebalance/lease API 已实现。
- 部署：服务默认值已经固化；2026-07-13 已验证默认 HTTPS `/healthz` 返回健康状态和实例 ID。进程守护、数据目录备份和外部健康监控仍需补齐。
- 待办：桌面团队来源/设备管理、按 assignment 申请租约采集、隔离事件详情/重试 UI、两台真实 Windows 设备验收。
