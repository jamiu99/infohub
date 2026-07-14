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
**走**：Electron 开一个 `BrowserWindow` 直接加载官方登录页 `https://mp.weixin.qq.com/`，自动切换到传统二维码，你用手机微信扫码，登录态由官方页面自己建立，App 只读取登录后的 session。

用户不应在 infohub 登录窗口输入账号、密码或验证码。微信公众平台当前会优先展示账号登录或依赖本地网络权限的“微信快捷登录”；`v0.1.2` 会通过页面自己的点击事件切到传统二维码，并拒绝设备权限、站外导航和页面弹窗。

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
2. BrowserWindow 加载 mp.weixin.qq.com，拒绝设备权限并只允许站内 HTTPS 导航
3. App 自动从账号/快捷登录切到传统二维码；失败时给出明确引导
4. 用户手机扫码登录【这一个号】→ 后台跳转 URL 带 token，监听 did-navigate 记录 lastToken
5. 用户关窗 → close 事件里 preventDefault，异步抓 cookie + 读昵称 + 用 lastToken 组装账号 → 入池
6. persist 分区持久化，下次免扫码。想加更多号 → 再点一次登录，另开独立分区
```

### 关键点

- **独立 `persist:wx-<id>` 分区**：每个号一套隔离的 cookie/token，互不干扰。这是多账号的正确地基。
- **关窗时捕获**：不监听中间导航态（避免误抓登录落地页），以关窗那刻的 lastToken + cookie 为准。
- **token 抓取**：登录成功后 URL 才带 token（`/[?&]token=(\d+)/`）。
- **中文引导横幅**：注入登录页顶部（Chromium 渲染中文正常），规避 WSLg 原生标题栏乱码。
- **二维码优先**：自动点击官方页面的扫码模式与传统二维码入口，不读取账号或密码输入框。
- **窗口收口**：所有权限默认拒绝，只允许 `https://mp.weixin.qq.com` 顶层导航，页面弹窗一律阻止。
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
  totalRequests: number;    // 本机累计认证接口请求数
  lastUsedAt?: number;
  lastRateLimitedAt?: number;
  requestsAtLastRateLimit?: number;      // 命中 200013 时，本小时第几次请求
  totalRequestsAtLastRateLimit?: number; // 命中时，本机累计第几次请求
}
```

- **凭据存储**：OS keychain 可用时用 Electron `safeStorage` 加密；不可用时当前会回退成明文 JSON。文件不入 git，但稳定版前需要告警与迁移机制，详见 [storage.md](storage.md#敏感数据)。
- **独立分区**：各号 cookie/token 完全隔离，互不覆盖。
- 账号池文件与正文资料库分离，见 [storage.md](storage.md)。账号密文和非敏感设置分别位于固定私有 `state/secrets/` 与 `state/settings.json`，不会随内容资料库迁移。

## 四、多账号与限流

代码默认使用刻意压低的保护值（`src/core/collect/rate-limit.ts`）；用户可以在“设置 → 采集与账号”修改每账号共用的小时保护上限，结果写入私有 `state/settings.json` 并立即生效：

| 参数 | 值 | 说明 |
|------|----|----|
| 频率控制错误码 | `200013` | `base_resp.ret == 200013` 即命中限流 |
| 每账号每小时 | **默认 20，可配置 1–1000** | 本地 1 小时窗口计数；超过 50 时看板提示风控风险 |
| 认证请求间隔 | **10s** | 搜索和全部公众号列表请求共用全局门，以上一个请求完成时刻计算 |
| 账号间间隔 | **15s** | 换号重试下一次认证请求前的最小间隔 |
| 公开正文间隔 | **2s** | 公众号公开文章页全局串行；不计入后台账号小时配额 |
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

### 测试期限流观测

- 看板逐账号显示本小时请求数和本机累计请求数；这里只统计需要账号登录态的 `searchbiz` / `appmsg` 调用，公开文章正文下载不计入账号配额。
- 每次请求在检查上游结果前先计数，因此命中 `200013` 时记录的是**包含触发请求本身**的准确序号。
- 最近一次限流会保存“本小时第几次、累计第几次、发生时间”，重启和小时窗口重置后仍保留；小时窗口只清零 `requestsThisHour`。
- 从旧版本升级时没有历史累计数据，因此 `totalRequests` 以升级当时的本小时计数为起点。
- 该功能只做被动观测，不自动压测、并发请求或主动撞限流。参考观察值 50 不是微信的稳定承诺，账号、时间和接口状态都可能改变阈值。

## 五、Cookie 失效检测与扫码引导

- **检测**：每次接口调用后看 `base_resp.ret`。非 0 且指示未登录（或请求被 302 到登录页）→ 判定该账号 cookie 失效，置 `expired`。
- **引导**：账号池面板把该账号显示为“登录失效”并提供“重新登录”；点击后 main 重新打开原 `persist:` 分区。当前没有全局 toast。
- **主动保活未实现**：只在搜索、手动刷新或用户已开启的自动采集实际调用认证接口后发现失效，不额外发送后台探测请求。

## 六、合规提醒

- 采集自己有权限的公众号后台数据；控制频率，尊重限流。
- 仓库当前已经是 GitHub Public。继续公开分发或扩展采集前，应单独评估接口条款、账号权限、频率与数据使用边界。
