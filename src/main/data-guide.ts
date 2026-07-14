// 在运行时数据目录生成稳定的数据接口说明。只描述文件/索引，不绑定任何 AI 或工具。
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Paths } from '../core/paths'
import { assertLibraryManifest } from './data-manifest'

export function ensureDataGuide(paths: Paths): void {
  // manifest 是资料库稳定身份，只能由启动/迁移流程创建和验证；
  // 生成说明文档绝不能用通用模板覆盖 libraryId。
  assertLibraryManifest(paths.root)
  mkdirSync(paths.outputs, { recursive: true })
  const guide = `<!-- 由 infohub 自动生成；应用升级时会覆盖本文件。 -->
# infohub 数据接口

infohub 只负责采集、归一化、索引和看板展示。外部程序通过普通文件或 SQLite 读取数据；infohub 不调用模型、不安装插件，也不启动外部处理进程。这里是可迁移的内容资料库，不包含登录凭据、团队 token 或本机运行设置。

## 目录

- <code>articles/&lt;sourceType&gt;/&lt;sourceId&gt;/&lt;articleId&gt;.md</code>：infohub 管理的当前规范化正文与元数据投影。
- <code>articles/&lt;sourceType&gt;/&lt;sourceId&gt;/&lt;articleId&gt;.&lt;contentHash&gt;.content.html</code>：版本化的公众号正文排版 sidecar；准确路径以 Article 的 <code>content.contentHtmlPath</code> 为准。
- <code>raw/&lt;sourceType&gt;/&lt;sourceId&gt;/&lt;externalIdHash&gt;/&lt;contentHash&gt;.json</code>：内容寻址的原始列表载荷；同一条目的历次不同响应都会保留。
- <code>raw/wechat/&lt;sourceId&gt;/pages/&lt;contentHash&gt;.page.html</code>：未改写、内容寻址的公众号完整公开页面，用于溯源和离线重解析。
- <code>sources.json</code>：当前关注的信源。
- <code>index.sqlite</code>：由文章文件重建的查询、状态与去重索引。
- <code>outputs/&lt;producer&gt;/</code>：外部处理程序唯一允许写入的区域；infohub 不读取、不索引，也不会用它覆盖文章。
- <code>infohub-library.json</code>：资料库格式与稳定 <code>libraryId</code> 身份标识。

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

1. 稳定文本正文与完整元数据以 Article Markdown 为准；需要保留公众号排版时，按 <code>content.contentHtmlPath</code> 读取 HTML sidecar。外部程序应只读 <code>articles/</code>。
2. 批量筛选、排序、去重时可读取 <code>index.sqlite</code>；索引可被删除并从文件重建。
3. <code>raw/</code> 是 infohub 保存的原始证据层，任何外部处理都不得修改、覆盖或清理；完整页面可能包含微信页面运行时内容。
4. AI/脚本等外部处理结果必须写入 <code>outputs/&lt;producer&gt;/</code>。不要修改 <code>raw/</code>、<code>articles/</code>、<code>sources.json</code> 或 <code>index.sqlite</code>。
5. 重新解析只会从不可变 raw 快照重建 Article 投影；联网重新抓取会新增快照，也不会覆盖旧响应。
6. 时间均为 UTC 毫秒时间戳，展示时再转换为本地时区。

数据根目录：<code>${paths.root}</code>
`
  writeFileSync(paths.guide, guide, 'utf8')
}
