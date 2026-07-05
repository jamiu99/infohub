---
name: summarize
description: >
  为 infohub 采集的文章生成摘要与价值打分。当需要总结文章、提炼要点、
  评估文章价值、或整理采集内容时使用。处理 articles/ 目录下的 markdown 文章。
allowed-tools: Read(./articles/**) Write(./articles/**) Bash(find ./articles*)
---

# 文章摘要 + 价值打分

为 infohub 采集的公众号/RSS 文章生成摘要、价值分与标签，回写到文章的 frontmatter。

## 数据结构

文章在 `./articles/<sourceType>/<sourceId>/<id>.md`，格式为 YAML-ish frontmatter + markdown 正文：

```
---
id: "..."
title: "标题"
publishedAt: 1750925178000
sourceUrl: "http://..."
source: {"id":"...","type":"wechat","name":"公众号名"}
summary: null          # ← 待你填
score: null            # ← 待你填
tags: []               # ← 待你填
ext: {...}
...
---
（markdown 正文）
```

## 任务

对每篇 `summary` 为 `null`（尚未处理）的文章：

1. 读取标题与正文。
2. 生成 **2-3 句中文摘要**，遵循：
   - 每句都带**具体实体**（人名/公司/产品/数字/结论），不写"正确的废话"。
   - 抓主要论点/发现 + 关键证据 + 实际影响。
   - 只依据正文，不臆造；正文不足就如实简短。
3. **价值打分** `score`（1-10）：
   - 1-3：软文/纯广告/标题党/无实质信息。
   - 4-6：一般资讯，了解即可。
   - 7-10：有洞见/可行动/重大事件。
   - 识别公众号软文特征（结尾引流、二维码、情感煽动后转向产品）→ 压低分。
4. 提取 **3-5 个标签** `tags`（主题词）。

## 回写方式

把结果写回该文章 frontmatter 的对应字段（`summary` 字符串、`score` 数字、`tags` 数组），
**保持其余字段与正文不变**。用 JSON 值格式（与现有行一致，如 `summary: "..."`、`score: 8`、`tags: ["a","b"]`）。

## 注意

- 只处理 `./articles/` 下的文章，不碰 `secrets/`。
- 一次可批量处理多篇；逐篇回写。
- 已有 `summary` 的文章跳过（除非用户要求重做）。
