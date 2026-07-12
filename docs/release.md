# 发布与自动更新

> 上级：[overview.md](overview.md)

## 当前发布状态

2026-07-13 的发布基线：

- 当前源码版本为 `v0.1.3`，发布说明见 [releases/v0.1.3.md](releases/v0.1.3.md)。
- 上个正式 GitHub Release 是 `v0.1.1`；`v0.1.2` 因 preload 回归已取消并转为 draft，不会被自动更新发现。
- Release workflow 已在 `v0.1.1` 补齐版本校验、typecheck 和核心测试。
- 尚无 Windows 安装人工验收或跨版本自动更新验收记录，不能把“存在更新代码”表述为“升级闭环已验收”。

仓库和 Release 当前是 **Public**，`electron-updater` 可直接读取公开 Release，无需客户端 token。

## 发布链路

推送 `v*` tag 会触发 `.github/workflows/release.yml`：

```text
checkout
  → pnpm 10 / Node 22
  → pnpm install --frozen-lockfile
  → 校验 tag = v + package.json.version
  → pnpm typecheck
  → pnpm test:core
  → pnpm build
  → pnpm verify:bundle
  → electron-builder --win --publish always
  → GitHub Release（releaseType: release）
```

普通 `main` push 和 pull request 会在 Ubuntu 上执行 `./verify.sh`，随后通过 Xvfb 实际启动 Electron，验证 preload 与 IPC 桥。

## 发布下一版本

不要复用旧 tag。例如发布 `0.1.4`：

```bash
# 1. 更新版本、文档和 release notes
pnpm version 0.1.4 --no-git-tag-version
./verify.sh

# 2. 确认工作树、提交和远端正确后再创建 tag
git tag v0.1.4
git push origin main
git push origin v0.1.4
```

约束：`package.json.version` 必须与 tag 去掉 `v` 后完全一致；Release workflow 会自动阻断不一致发布。

Release notes 必须明确数据格式变化、迁移方式与已知限制；如曾包含直接 AI 集成，还要说明相关资源是否被移除或只被忽略。

## App 内自动更新

`src/main/updater.ts` 在打包环境启动 5 秒后检查更新：

- 有新版则自动下载。
- renderer 通过 `update-status` 接收下载进度。
- 下载完成后 `UpdateBanner` 提供“重启并更新”。
- 退出时允许静默安装。
- 开发环境（`process.defaultApp`）不自动检查。

真正验证自动更新必须在已安装旧版上观察检查、下载、重启安装与数据保留。仓库已有连续版本和更新元数据，但尚无真实 Windows 跨版本人工验收记录，因此不能宣称升级闭环已验收。

## Windows 安装注意

- NSIS 为 x64、当前用户安装、可选择目录、创建桌面和开始菜单快捷方式。
- 暂无代码签名，SmartScreen 会显示未知发行者；个人试用可人工确认，公开分发应评估签名。
- 正式 Windows 包由 `windows-latest` 构建；Linux/WSL 本地交叉打包不作为发布依据。

## 发布前检查清单

- [ ] `main` 已同步，工作树只包含本次发布内容。
- [ ] 版本号、tag、文档一致。
- [ ] `pnpm typecheck`、`pnpm test:core`、`pnpm build`、`pnpm verify:bundle` 通过。
- [ ] 扫码、RSS、文章阅读和数据升级做过最小人工验收。
- [ ] Release notes 说明数据格式/安全/已知限制。
- [ ] Actions 成功，Release 非 draft，安装包、blockmap、`latest.yml` 齐全。
- [ ] 从旧版本完成一次自动更新并确认数据未丢失。
