# 处理层（process）

> 上级：[overview.md](overview.md) · 输入 `RawItem`（[ingest](ingest.md)）· 输出 `Article`（[contract](contract.md)）

职责：把原始条目二次处理成统一、干净、有价值的 `Article`。**渐进式**——一条 Article 可以只跑清洗就入库，AI 增强按需后补。

## 处理阶段（pipeline，各步独立可开关）

```
RawItem
  │
  ├─ 1. 归一化（必做）
  │     信源特色字段 → Article 标准字段 + ext
  │     wechat: {title, digest, link, create_time, cover, author_name, fakeid}
  │            → title / sourceUrl=link / publishedAt=create_time*1000 / ext={...}
  │     统一时间为 UTC ms（存 UTC，展示本地时区）
  │
  ├─ 2. 正文抓取 / 清洗（按信源）
  │     公众号 list_ex 只给 digest+link，正文需另抓 link 页面 → 转 markdown
  │     去广告/模板噪声，保留正文与图片引用
  │
  ├─ 3. AI 二次转写（可选，调 API/AI）
  │     - 摘要 summary
  │     - 价值打分 score（老/无价值 → 低分）
  │     - 老化判断 staleness: fresh/aging/stale
  │     - 标签 tags
  │
  └─ 4. 溯源校验（可选）
        核对 sourceUrl 可达、内容与来源一致 → provenance.{verified, note}
        「溯源后有问题」的标记，供下游过滤
  ▼
Article → 交 store 落地
```

## 要点

- **阶段解耦**：每阶段读写的都是 Article 字段，缺某步只是对应字段为空，不阻塞入库。
- **AI 调用走 agent 层**：摘要/打分等可由 [agent.md](agent.md) 的 CLI 或 API 完成，process 只定义"要什么"，不绑定具体模型。
- **可重放**：`raw/` 保留原始载荷，处理逻辑升级后可对旧数据重跑，不用重新采集。
- **老化与价值**：`score` + `staleness` 是简报（P2）筛选的依据——低价值/过期的不进简报。
