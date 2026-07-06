# 发布与自动更新

> 上级：[overview.md](overview.md)

Windows 安装包由 **GitHub Actions 在 Windows 云构建机**编译并发布到 GitHub Release；App 内置
**electron-updater** 自动检查更新。你只需下载一次，之后 App 自动更新。

## 一次性发布流程

```bash
# 1. 改版本号（package.json 的 version）
# 2. 打 tag 并推送 —— 触发 CI
git tag v0.1.0
git push origin v0.1.0
```

推 `v*` tag → `.github/workflows/release.yml` 在 `windows-latest` 上：
`pnpm install → pnpm build（electron-vite）→ electron-builder --win --publish always`
→ 产出 NSIS 安装包 + `latest.yml`（更新元数据）发布到 [Release](https://github.com/jamiu99/infohub/releases)。

首个版本 CI 会创建 draft/release；到 Release 页面下载 `infohub-Setup-<版本>.exe` 安装。

## 自动更新怎么工作

- `src/main/updater.ts`：启动 5 秒后 `checkForUpdates()`，有新版**自动后台下载**，
  下载完通过 `update-status` 事件通知前端，`UpdateBanner.vue` 弹「重启并更新」。
- 退出时静默安装（`autoInstallOnAppQuit`）。
- 更新源 = 公开仓的 GitHub Release（`electron-builder.yml` 的 `publish` 配置），**无需 token**。

## 首次安装的提示

未做代码签名（个人使用）→ Windows SmartScreen 首次会提示"未知发行者"，点
**"更多信息" → "仍要运行"** 即可。要消除提示需 Windows 代码签名证书（年费，暂不做）。

## 本地打包（可选，调试用）

```bash
pnpm pack:win     # 只打包不发布，产物在 release/
```
注意：在 Linux/WSL 上交叉编译 Windows 包不可靠，正式发布走 CI（Windows 原生构建）。

## 版本号约定

`package.json` 的 `version` 与 git tag 必须一致（tag `v0.1.0` ↔ version `0.1.0`）。
electron-updater 靠版本号比较决定是否有新版，务必每次发布前 +1。
