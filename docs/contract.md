# 数据契约

> 上级：[overview.md](overview.md) · 这是所有模块的"接头暗号"，改字段必须回来改这里并通知下游。

契约是模块解耦的关键：ingest 只需产出 `RawItem`，process 只认 `RawItem` 产出 `Article`，谁都不关心对方内部怎么实现。**字段稳定 = 下游高度灵活。**

## Source — 信源定义

```ts
interface Source {
  id: string;             // 稳定唯一 id
  type: 'wechat' | 'rss' | string;  // 可拓展：未来 adapter 自定义 type
  name: string;           // 展示名，如 "特工宇宙"
  enabled: boolean;
  config: Record<string, unknown>;  // 各 adapter 自定义（wechat: fakeid；rss: feedUrl）
  lastFetchedAt?: number; // UTC 毫秒时间戳
}
```

## RawItem — 原始采集产物（未清洗）

ingest 层的唯一输出。保留信源原样载荷，**不做任何加工**，方便溯源和 process 层重放。

```ts
interface RawItem {
  sourceId: string;
  sourceType: string;
  fetchedAt: number;       // 采集时刻 UTC 毫秒
  externalId: string;      // 信源内唯一 id（wechat: aid/link；rss: guid）→ 用于去重
  raw: Record<string, unknown>;  // 原始字段整包（如公众号 app_msg_list 的一项）
}
```

## Article — 统一结构（处理层产物，全局通用）

这是**整个系统的核心数据结构**。所有信源处理后都归一到它，下游（存储/检索/简报/知识库）只认它。

```ts
interface Article {
  id: string;              // 全局唯一（sourceId + externalId 派生）
  title: string;           // 标题
  body: string;            // 正文（markdown）
  publishedAt: number;     // 发布时间 UTC 毫秒（存 UTC，展示本地时区）
  sourceUrl: string;       // 原始来源 URL（溯源用）
  source: { id: string; type: string; name: string };

  // —— 处理层产出的增强字段（可空，取决于是否跑过对应处理）——
  summary?: string;        // AI 摘要
  score?: number;          // 价值打分 0-100
  staleness?: 'fresh' | 'aging' | 'stale';  // 老化判断
  provenance?: {           // 溯源校验结果
    verified: boolean;
    note?: string;
  };
  tags?: string[];

  // —— 可拓展字段：不同信源的特色元数据有处安放 ——
  ext: Record<string, unknown>;  // wechat: {fakeid, cover, author_name}; rss: {categories}

  // —— 存储/状态元信息 ——
  filePath?: string;       // 落地文件相对路径（store 填充）
  createdAt: number;
  updatedAt: number;
}
```

### 设计要点

1. **`ext` 是 AI Native 的杠杆**：新信源加字段只往 `ext` 塞，核心结构不动，下游不受影响。
2. **时间统一 UTC 毫秒**：存 UTC，展示按本地时区（遵 harness taste 约定）。
3. **`sourceUrl` + `provenance` 支撑溯源**：处理层可标记"这条溯源有问题"。
4. **增强字段全部可空**：Article 可以只被采集清洗、未经 AI 处理就先入库，处理是渐进的。

## AI 适配新信源的姿势

未来加信源 = 写一个 adapter，实现 `ingest` 接口产出 `RawItem`，再在 `process` 里把该信源的 `raw` 映射进 `Article`（含 `ext`）。见 [ingest.md](ingest.md#adapter-接口) 与 [agent.md](agent.md#ai-自我修改受控)。
