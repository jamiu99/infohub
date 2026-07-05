# infohub — 个人信息处理中枢

本地桌面 App（Electron）。把分散信源（微信公众号 / RSS / …）采集到本地，二次处理成统一结构，归档、检索，并接入 AI（Claude Code / Codex 等 CLI）产出价值（摘要、简报、知识库）。

**核心亮点**：掌握微信公众号后台引用接口的采集方法，通过扫码登录公众号平台即可采集；支持多账号轮换绕开单账号每日配额。

**设计哲学**：数据最终都是文件（markdown + json），模块彻底拆分，通用 agent 在数据目录下天然可工作。

## 启动

```bash
./start.sh          # 见 start.sh 注释（只负责启动，不装依赖）
```

## 文档

一切从 [`docs/overview.md`](docs/overview.md) 进（进度与索引主文件）。
