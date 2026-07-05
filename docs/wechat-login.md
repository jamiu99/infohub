# 微信公众号：扫码登录 · Cookie 抓取 · 多账号 · 限流

> 上级：[overview.md](overview.md) · 采集接口见 [ingest.md](ingest.md#微信公众号) · 源参考：`refs/get_wechat_list`（代码烂，只取核心接口逻辑）

这是本项目的**核心亮点与技术壁垒**。公众号后台的两个引用接口能抓文章，但要求登录态（cookie + token）。目标：**你只扫码，App 自动把 cookie/token 存好，失效自动引导重扫。**

## 一、采集依赖的鉴权三要素

两个接口（searchbiz / appmsg，见 [ingest.md](ingest.md#微信公众号)）都需要：

| 要素 | 来源 | 说明 |
|------|------|------|
| **cookie** | 登录后浏览器 session | 关键是 `slave_sid` / `slave_user` / `bizuin` 等，整包带上最稳 |
| **token** | 登录后跳转 URL 的 `?token=` 参数 | 后台每个页面 URL 都带，是接口必填 query |
| **fingerprint** | 页面内生成 | 可从后台页面 JS 上下文或某次请求里取；缺了部分接口也能过，先尽量抓 |

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

多账号是**绕开单账号每日配额**的手段。账号池存本地（cookie/token 属敏感数据，加密存储）。

```ts
interface WxAccount {
  id: string;
  identityKey?: string;     // 身份键（优先公众号昵称）→ 去重/更新用
  nickname?: string;        // 公众号名，切到该号时从页面读
  token: string;            // 该号当前 token（切换/失效会更新）
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

- **加密存储**：cookie/token 用 Electron `safeStorage`（OS keychain 加密）落盘，不明文入库、不入 git。
- **独立分区**：各号 cookie/token 完全隔离，互不覆盖。
- 账号池文件与正文数据分离，见 [storage.md](storage.md)。

## 四、多账号与限流

源参考里的实测限流参数（`refs/.../rate_limit_config.py`）直接采纳：

| 参数 | 值 | 说明 |
|------|----|----|
| 频率控制错误码 | `200013` | `base_resp.ret == 200013` 即命中限流 |
| 每账号每小时 | ~50 请求（保守 30） | 滑动窗口计数 |
| 请求间隔 | 5s（保守 8s） | 同账号连续请求间 sleep |
| 账号间间隔 | 10s | 轮换账号时的间隔 |
| 命中后冷却 | 7200s（2h） | 命中 200013 → 该账号 `cooldown` 2 小时 |
| 单账号单次页数 | 增量 3 页 / 历史 20 页 | 控制单账号消耗 |

### 调度策略

```
采集任务来 → 从池里挑一个 status=active 且未超小时配额的账号
  ├─ 有 → 用它，请求间隔 sleep，计数 +1
  ├─ 命中 200013 → 该账号置 cooldown（+2h），换下一个账号重试
  ├─ cookie 失效（ret 表示未登录 / 跳登录页）→ 该账号置 expired，触发扫码引导
  └─ 全部账号 cooldown/expired → 任务排队等待最早恢复的账号，或提示用户加账号
```

## 五、Cookie 失效检测与扫码引导

- **检测**：每次接口调用后看 `base_resp.ret`。非 0 且指示未登录（或请求被 302 到登录页）→ 判定该账号 cookie 失效，置 `expired`。
- **引导**：renderer 弹提示"账号 X 登录已失效，请重新扫码"，点击 → main 重新打开该账号 `persist:` 分区的 BrowserWindow 走[二、扫码流程]。因分区持久化，很多时候页面还在、只需刷新确认。
- **主动保活**：可低频探测（如每天一次轻量 searchbiz）提前发现失效，避免采集时才暴雷。

## 六、合规提醒

- 采集自己有权限的公众号后台数据；控制频率，尊重限流。
- 是否开源会影响合规策略（见 [overview.md](overview.md#6-未决待定项)），开源前需评估。
