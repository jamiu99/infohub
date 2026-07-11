# 微信公众号：扫码登录 · Cookie 抓取 · 多账号 · 限流

> 上级：[overview.md](overview.md) · 采集接口见 [ingest.md](ingest.md#微信公众号) · 源参考：`refs/get_wechat_list`（代码烂，只取核心接口逻辑）

公众号后台的两个引用接口能抓文章，但要求登录态（cookie + token）。当前实现目标是：用户只在官方页面扫码，App 保存本机登录态；失效后由用户主动重新登录。相关接口可能变化，且真实账号安全优先于采集速度。

## 一、采集依赖的鉴权三要素

两个接口（searchbiz / appmsg，见 [ingest.md](ingest.md#微信公众号)）都需要：

| 要素 | 来源 | 说明 |
|------|------|------|
| **cookie** | 登录后浏览器 session | 关键是 `slave_sid` / `slave_user` / `bizuin` 等，整包带上最稳 |
| **token** | 登录后跳转 URL 的 `?token=` 参数 | 后台每个页面 URL 都带，是接口必填 query |
| **fingerprint** | 页面内生成 | 当前登录代码未提取，接口请求传空字符串；历史联调可用，但兼容性风险仍在 |

## 二、扫码登录方案：内嵌 BrowserWindow（不模拟登录接口）

**不走**模拟登录 API（要处理账密、验证码、风控，脆弱且违规风险高）。
**走**：Electron 开一个 `BrowserWindow` 直接加载官方登录页 `https://mp.weixin.qq.com/`，你用手机微信扫码，登录态由官方页面自己建立，App 只是"读"这个窗口的 session。

### ⚠️ 关键认知（经用户确认，2026-07-06 定稿）

用户要采集的号是**不同微信号的独立账号**，各自独立扫码登录。这决定了多账号的正确做法：

- 每个号用**独立会话分区** `persist:wx-<id>` → cookie/token **完全隔离**，互不覆盖、互不失效。
- **不做**任何"切换账号"逻辑（那是同一微信号名下多公众号的场景，与此不符）。
- 因为各号独立，**不存在"切换后旧 token 失效"问题**——每个号的 token 只属于自己。
- 采集只需任一有效 token 就能 searchbiz 搜 / appmsg 拉任何目标号 → 多个独立号 = **真正的轮换池分摊请求量**（独立主体，配额分摊有效）。

> 曾一度误设计为"共享分区 + 切换账号自动捕获"，因用户场景是独立微信号而推翻。若共享分区登第二个号会覆盖第一个的登录态——独立分区才正确。

### 流程（当前实现 `src/main/wechat-login.ts`）

```
1. 点"扫码登录" → main 生成新 id，开独立分区 session.fromPartition('persist:wx-<id>')
2. BrowserWindow 加载 mp.weixin.qq.com，注入中文引导横幅（原生标题栏 WSLg 无中文字体，故走页面内）
3. 用户手机扫码登录【这一个号】→ 后台跳转 URL 带 token，监听 did-navigate 记录 lastToken
4. 用户关窗 → close 事件里 preventDefault，异步抓 cookie + 读昵称 + 用 lastToken 组装账号 → 入池
5. persist 分区持久化，下次免扫码。想加更多号 → 再点一次登录，另开独立分区
```

### 关键点

- **独立 `persist:wx-<id>` 分区**：每个号一套隔离的 cookie/token，互不干扰。这是多账号的正确地基。
- **关窗时捕获**：不监听中间导航态（避免误抓登录落地页），以关窗那刻的 lastToken + cookie 为准。
- **token 抓取**：登录成功后 URL 才带 token（`/[?&]token=(\d+)/`）。
- **中文引导横幅**：注入登录页顶部（Chromium 渲染中文正常），规避 WSLg 原生标题栏乱码。
- **fingerprint**：登录时未强制抓，缺失多数接口仍可用；如遇校验失败再从页面 JS 上下文补抓。

## 三、账号池与持久化

多账号用于在多个独立主体之间保守分摊请求。账号池只存本机；cookie/token 属敏感数据。

```ts
interface WxAccount {
  id: string;
  nickname?: string;        // 登录后尽量从页面读取
  token: string;            // 当前后台 token（重登时更新）
  cookies: Record<string, string>;
  fingerprint?: string;
  partition: string;        // 每个号独立 persist:wx-<id>
  status: 'active' | 'cooldown' | 'expired';
  cooldownUntil?: number;   // 命中限流后的恢复时刻（UTC ms）
  requestsThisHour: number; // 滑动窗口计数
  windowStart: number;
  lastUsedAt?: number;
}
```

- **凭据存储**：OS keychain 可用时用 Electron `safeStorage` 加密；不可用时当前会回退成明文 JSON。文件不入 git，但稳定版前需要告警与迁移机制，详见 [storage.md](storage.md#敏感数据)。
- **独立分区**：各号 cookie/token 完全隔离，互不覆盖。
- 账号池文件与正文数据分离，见 [storage.md](storage.md)。

## 四、多账号与限流

代码当前使用刻意压低的保护值（`src/core/collect/rate-limit.ts`）：

| 参数 | 值 | 说明 |
|------|----|----|
| 频率控制错误码 | `200013` | `base_resp.ret == 200013` 即命中限流 |
| 每账号每小时 | **20 请求** | 本地 1 小时窗口计数，低于参考实测上限 |
| 请求间隔 | **10s** | 同一采集任务翻页之间 sleep |
| 账号间间隔 | **15s** | 换号重试前的间隔 |
| 命中后冷却 | 7200s（2h） | 命中 200013 → 该账号 `cooldown` 2 小时 |
| 默认单源页数 | **1 页 × 10 条** | `incrementalMaxPages=1`；历史上限常量 20 暂未使用 |

### 调度策略

```
采集任务来 → 从池里挑一个 status=active 且未超小时配额的账号
  ├─ 有 → 发请求并计数
  ├─ 命中 200013 → 该账号 cooldown 2h，换下一个账号重试当前页
  ├─ cookie 失效 → 该账号 expired，换下一个账号重试当前页
  ├─ 普通错误 → 返回 error，不自动换号
  └─ 无可用账号 → 本次返回 no_account，不跨时间排队
```

`earliestRecovery()` 和 `waiting_quota` 契约已经存在，但 Service 尚未把任务持久化或等待到恢复时刻。

## 五、Cookie 失效检测与扫码引导

- **检测**：每次接口调用后看 `base_resp.ret`。非 0 且指示未登录（或请求被 302 到登录页）→ 判定该账号 cookie 失效，置 `expired`。
- **引导**：账号池面板把该账号显示为“登录失效”并提供“重新登录”；点击后 main 重新打开原 `persist:` 分区。当前没有全局 toast。
- **主动保活未实现**：当前只在用户搜索/刷新触发接口后发现失效，不做后台探测。

## 六、合规提醒

- 采集自己有权限的公众号后台数据；控制频率，尊重限流。
- 仓库当前已经是 GitHub Public。继续公开分发或扩展采集前，应单独评估接口条款、账号权限、频率与数据使用边界。
