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

### 流程

```
1. main 进程为该账号创建独立 session 分区：
   session.fromPartition('persist:wx-<accountId>')
2. new BrowserWindow({ webPreferences: { session } }) 加载 mp.weixin.qq.com
3. 用户手机扫码 → 官方页面完成登录 → 跳转到 /cgi-bin/home?...&token=XXXX
4. 监听 webContents 'did-navigate' / will-redirect：
   - 从 URL 正则抓 token： /[?&]token=(\d+)/
   - 从 session.cookies.get({ url: 'https://mp.weixin.qq.com' }) 抓全部 cookie
5. 存入账号池（见下），关闭登录窗口
6. 用 persist: 分区，cookie 落 Electron 磁盘，下次免扫直到失效
```

### 关键点

- **`persist:` 分区**：每个账号独立分区 → 天然隔离多账号 cookie，互不污染。这是多账号方案的地基。
- **token 抓取时机**：登录成功后 URL 才带 token；监听导航事件、匹配到含 `token=` 的 mp 后台 URL 即可提取。
- **fingerprint**：可在登录窗口 `webContents.executeJavaScript` 里从页面上下文提取，或抓一次后台 XHR 的 query 拿到。抓不到就留空，优先保证 token+cookie。

## 三、账号池与持久化

多账号是**绕开单账号每日配额**的手段。账号池存本地（cookie/token 属敏感数据，加密存储）。

```ts
interface WxAccount {
  id: string;
  nickname?: string;        // 登录后可从后台页面读
  token: string;
  cookies: Record<string, string>;
  fingerprint?: string;
  partition: string;        // persist:wx-<id>
  status: 'active' | 'cooldown' | 'expired';
  cooldownUntil?: number;   // 命中限流后的恢复时刻（UTC ms）
  requestsThisHour: number; // 滑动窗口计数
  windowStart: number;
  lastUsedAt?: number;
}
```

- **加密存储**：cookie/token 用 Electron `safeStorage`（OS keychain 加密）落盘，不明文入库、不入 git。
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
