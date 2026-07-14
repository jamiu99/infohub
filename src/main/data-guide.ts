// 在运行时数据目录生成稳定的数据接口说明。只描述文件/索引，不绑定任何 AI 或工具。
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Paths } from '../core/paths'

export function ensureDataGuide(paths: Paths): void {
  mkdirSync(paths.root, { recursive: true })
  const guide = `<!-- 由 infohub 自动生成；应用升级时会覆盖本文件。 -->
# infohub 数据接口

infohub 只负责采集、归一化、索引和看板展示。外部程序通过普通文件或 SQLite 读取数据；infohub 不调用模型、不安装插件，也不启动外部处理进程。

## 目录

- <code>articles/&lt;sourceType&gt;/&lt;sourceId&gt;/&lt;articleId&gt;.md</code>：文章内容与元数据，数据真相源。
- <code>articles/&lt;sourceType&gt;/&lt;sourceId&gt;/&lt;articleId&gt;.content.html</code>：可选的公众号正文原始排版 sidecar，与 Markdown 一一对应。
- <code>raw/&lt;sourceType&gt;/&lt;sourceId&gt;/*.json</code>：采集原始载荷，用于溯源和重放。
- <code>raw/wechat/&lt;sourceId&gt;/*.page.html</code>：未改写的公众号完整公开页面，用于离线重解析；不作为文章列表接口。
- <code>sources.json</code>：当前关注的信源。
- <code>settings.json</code>：infohub 的非敏感本地运行设置，不属于内容接口。
- <code>index.sqlite</code>：由文章文件重建的查询、状态与去重索引。
- <code>team/</code>：团队 outbox、acked、quarantine 和增量游标，属于内部同步状态，不是内容接口。
- <code>secrets/</code>：登录凭据和团队设备 token，任何外部消费者都不应读取、复制或索引。

## Article 文件

每篇文章是 JSON 值 frontmatter + Markdown 正文。稳定核心字段：

- <code>id</code>、<code>externalId</code>
- <code>title</code>、<code>publishedAt</code>、<code>sourceUrl</code>
- <code>source: { id, type, name }</code>
- <code>ext</code>：信源特有的原始元数据
- <code>content</code>（可选）：正文状态、解析器版本、最近尝试时间，以及相对 <code>articles/</code> / <code>raw/</code> 的 HTML 路径
- <code>team</code>（可选）：团队文章 ID、贡献者和本机是否贡献；不包含登录凭据
- <code>read</code>、<code>archived</code>、<code>createdAt</code>、<code>updatedAt</code>

## 消费约定

1. 稳定文本正文与完整元数据以 Article Markdown 为准；需要保留公众号排版时，按 <code>content.contentHtmlPath</code> 读取 HTML sidecar。
2. 批量筛选、排序、去重时可读取 <code>index.sqlite</code>；索引可被删除并从文件重建。
3. <code>raw/</code> 只用于溯源与重新解析，不应当作归一化后的文章接口；完整页面可能包含微信页面运行时内容。
4. 默认按只读方式消费。外部写入若破坏核心字段，infohub 不保证兼容。
5. 时间均为 UTC 毫秒时间戳，展示时再转换为本地时区。

数据根目录：<code>${paths.root}</code>
`
  writeFileSync(paths.guide, guide, 'utf8')
}
