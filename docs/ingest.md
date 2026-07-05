# 采集层（ingest）

> 上级：[overview.md](overview.md) · 契约见 [contract.md](contract.md) · 公众号登录见 [wechat-login.md](wechat-login.md)

职责：从各信源拿到**原始数据**，产出 `RawItem[]`。**只负责取，不清洗、不入正式库**。

## adapter 接口

每种信源 = 一个 adapter，实现同一接口。加新信源 = 加一个 adapter，其余模块不动。

```ts
interface SourceAdapter {
  type: string;                              // 'wechat' | 'rss' | ...
  // 可选：搜索/发现信源（如公众号按名搜 fakeid）
  discover?(query: string): Promise<Array<{ id: string; name: string; meta?: object }>>;
  // 拉取：给定 Source 配置，产出原始条目
  fetch(source: Source, opts?: { since?: number; maxPages?: number }): Promise<RawItem[]>;
}
```

adapter 注册到一个 registry，process/调度层按 `source.type` 找对应 adapter。

## 微信公众号

复用 `refs/get_wechat_list` 的**核心接口逻辑**（那仓代码烂，只取这两个 GET）。鉴权三要素来自账号池，见 [wechat-login.md](wechat-login.md)。

### 接口 1：搜公众号 → fakeid（`discover`）

```
GET https://mp.weixin.qq.com/cgi-bin/searchbiz
query: action=search_biz & query=<名称> & begin=0 & count=5
       & token=<token> & fingerprint=<fp> & lang=zh_CN & f=json & ajax=1
cookie: <账号 cookie>
→ list[].{ fakeid, nickname, alias, signature }
```

### 接口 2：拉文章列表（`fetch`）

```
GET https://mp.weixin.qq.com/cgi-bin/appmsg
query: action=list_ex & fakeid=<fakeid> & begin=<n> & count=10 & type=9
       & need_author_name=1 & token=<token> & fingerprint=<fp> & f=json & ajax=1
cookie: <账号 cookie>
→ app_msg_cnt, app_msg_list[].{ aid, title, digest, link, cover,
                                author_name, create_time, update_time, ... }
```

映射到 `RawItem`：`externalId = link`（去重键），`raw = app_msg_list 项整包`。
分页：`begin += count` 循环，命中错误码 `200013` 即限流（见 [wechat-login.md](wechat-login.md#四多账号与限流)）。
每次请求间隔 sleep，翻页受 `maxPages` 限制。

### wechat adapter config

`Source.config` 里存：`{ fakeid: string }`（由 discover 得到）。账号选择交给调度层从账号池取，adapter 本身无状态。

## RSS（P0 打通全链路用）

标准 RSS/Atom：给定 `feedUrl`，拉取解析每个 entry → `RawItem`（`externalId = guid`，`raw = entry`）。
RSS 是 P0 首个跑通的 adapter——它无需登录，最快验证「采集 → 处理 → 存储 → agent」整条链路。

## 未来信源：AI 写 adapter

新信源交给 AI：给它 `SourceAdapter` 接口 + `RawItem` 契约 + 目标信源的接口/页面样本，让它生成一个 adapter。这是产品 AI Native 的杠杆点，受控流程见 [agent.md](agent.md#ai-自我修改受控)。
