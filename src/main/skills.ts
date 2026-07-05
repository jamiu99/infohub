// 把 App 内置 skills 安装到数据目录，供用户在 data/ 里跑 claude 时自动发现。
// 见 docs/agent.md（skill 机制）。用户形态：不由 App 触发，用户自己终端跑 claude。
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from '../core/paths'

/**
 * 安装内置 skills 到 data/.claude/skills/，并写一份数据目录 README 引导用户。
 * @param resourcesSkillsDir App 打包内的 skills 源目录（resources/skills）
 */
export function installSkills(paths: Paths, resourcesSkillsDir: string): void {
  mkdirSync(paths.skills, { recursive: true })
  mkdirSync(paths.briefings, { recursive: true })

  // 复制内置 skills（覆盖，保证随 App 升级更新到最新版）
  if (existsSync(resourcesSkillsDir)) {
    cpSync(resourcesSkillsDir, paths.skills, { recursive: true })
  }

  // 数据目录 README：告诉用户怎么用 claude + skill 处理数据
  const readme = `# infohub 数据目录

这里是 infohub 的本地数据，**全是文件**，任何通用 agent（Claude Code 等）都能直接在此工作。

## 目录

- \`articles/\`  采集的文章（markdown + frontmatter），按 <信源类型>/<信源id>/ 组织
- \`briefings/\` 简报产出（agent 生成）
- \`raw/\`       原始采集载荷（溯源用）
- \`.claude/skills/\` 内置技能（agent 自动发现）
- \`sources.json\` 关注的信源清单
- \`index.sqlite\` 检索索引（可从 articles/ 重建）

## 怎么用 AI 处理这些数据

在**本目录**打开终端，直接跑本机的 \`claude\`（复用你的登录态，无需 API key）：

\`\`\`bash
cd "${paths.root}"

# 让 agent 用 summarize 技能给文章生成摘要+打分（自动发现 .claude/skills/summarize）
claude -p "用 summarize 技能给还没处理的文章生成摘要和价值打分" --permission-mode acceptEdits

# 或交互式，自由指挥
claude
\`\`\`

技能定义在 \`.claude/skills/\`，你可以照着改或加新技能——agent 会自动发现。
`
  const readmePath = join(paths.root, 'README.md')
  if (!existsSync(readmePath)) writeFileSync(readmePath, readme)
}
