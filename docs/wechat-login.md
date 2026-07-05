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

### ⚠️ 关键认知（经用户确认 + 调研，2026-07-06 修正）

用户的多个公众号**都挂在同一个微信号名下**（拥有运营权）。这决定了多账号的正确做法：

- 直接登某个号 → **要输密码**（麻烦）。
- 先扫码登主微信号 → 用后台**「切换账号」**切到旗下各号 → **全程免密**。
- 每切一个号，URL 里的 **token 会变**（cookie 基本不变，同一微信会话）。
- 采集只需**任一**有效 token 就能 searchbiz 搜 / appmsg 拉**任何**目标号 → 多 token = **轮换池分摊请求量**。

所以 ❌ 不是"每个号独立分区各自扫码"（那样每号都要输密码），而是 ✅ **单一共享分区 + 一次扫码 + 监听 token 变化自动捕获**。

### 流程（当前实现 `src/main/wechat-login.ts`）

```
1. 所有号共享一个分区：session.fromPartition('persist:wx-main')
2. 打开 BrowserWindow 加载 mp.weixin.qq.com，用户手机扫码登录主微信号
3. 用户在窗口内点后台「切换账号」，切到旗下每个要采集的号
4. App 监听 'did-navigate' / 'did-navigate-in-page'：
   - 每出现一个【新】token（/[?&]token=(\d+)/，去重 seenTokens）
   - 就抓该刻 cookie + 读昵称，回调 onCapture → 入池
5. 用户切完关窗，count 个号已进池。persist 分区持久化，下次免扫码
```

### 关键点

- **单一 `persist:wx-main` 分区**：一次扫码即持久化整个微信会话；旗下所有号共享它，切换免密。
- **按 token 变化捕获**：切换账号 = URL token 变，监听导航即可无感捕获，无需用户额外操作。
- **身份去重**：用 `identityKey`（优先公众号昵称）识别同一号，重复捕获则**更新** token 而非新增。
- **配额分摊存疑**：同一微信号下切出的多 token，能否真正躲开 200013 取决于微信按什么维度限流（微信号 vs token）——**需采集时实测**。机制先按此工作流建。
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
  partition: string;        // 统一 persist:wx-main（同一微信会话）
  status: 'active' | 'cooldown' | 'expired';
  cooldownUntil?: number;   // 命中限流后的恢复时刻（UTC ms）
  requestsThisHour: number; // 滑动窗口计数
  windowStart: number;
  lastUsedAt?: number;
}
```

- **加密存储**：cookie/token 用 Electron `safeStorage`（OS keychain 加密）落盘，不明文入库、不入 git。
- **共享 cookie**：所有号同分区，cookie 大体共享，差异主要在各自的 token。
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
