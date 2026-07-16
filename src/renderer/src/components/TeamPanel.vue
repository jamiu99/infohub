<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store } from '../stores/app'
import { dateTime } from '../util'
import { DEFAULT_TEAM_SERVER_URL } from '../../../shared/team'
import { userFacingError } from '../../../shared/errors'

const showJoin = ref(false)
const serverUrl = ref(DEFAULT_TEAM_SERVER_URL)
const memberName = ref('')
const deviceName = ref('')
const teamToken = ref('')
const actionError = ref('')
const actionMessage = ref('')
const autoSyncEnabled = ref(true)
const intervalMinutes = ref(5)
const scheduleSaving = ref(false)

const status = computed(() => store.state.team)
const joined = computed(() => Boolean(status.value?.device))
const busy = computed(
  () => scheduleSaving.value || store.state.teamLoading || status.value?.state === 'syncing'
)
const statusError = computed(() =>
  store.state.teamError ||
  (status.value?.error ? userFacingError(status.value.error, '团队同步异常') : '')
)

watch(
  () => status.value?.serverUrl,
  (value) => {
    if (value && !joined.value) serverUrl.value = value
  },
  { immediate: true }
)

watch(
  status,
  (value) => {
    if (!value || scheduleSaving.value) return
    autoSyncEnabled.value = value.autoSyncEnabled
    intervalMinutes.value = value.intervalMinutes
  },
  { immediate: true }
)

function textField(value: unknown, keys: string[]): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const fields = value as Record<string, unknown>
  for (const key of keys) {
    if (typeof fields[key] === 'string' && fields[key]) return fields[key] as string
  }
  return ''
}

const deviceLabel = computed(() =>
  textField(status.value?.device, ['name', 'deviceName', 'id']) || '当前设备'
)
const memberLabel = computed(() =>
  textField(status.value?.device, ['memberName', 'member'])
)
const scheduleText = computed(() => {
  if (!autoSyncEnabled.value) {
    return '自动同步已关闭；本机新采结果仍会排队，可随时手动同步。'
  }
  if (status.value?.state === 'syncing') return '正在同步；完成后会重新等待完整周期。'
  if (status.value?.nextSyncAt) return `下次自动同步：${dateTime(status.value.nextSyncAt)}`
  return '自动同步已开启，下一轮将在完整周期后开始。'
})

function resetFeedback(): void {
  actionError.value = ''
  actionMessage.value = ''
}

function openJoin(): void {
  resetFeedback()
  serverUrl.value = status.value?.serverUrl || DEFAULT_TEAM_SERVER_URL
  showJoin.value = true
}

function closeJoin(): void {
  if (store.state.teamLoading) return
  teamToken.value = ''
  showJoin.value = false
}

function validateJoin(): string {
  if (!memberName.value.trim()) return '请填写成员名'
  if (!deviceName.value.trim()) return '请填写设备名'
  if (!teamToken.value) return '请填写服务器 TEAM_TOKEN'
  try {
    const url = new URL(serverUrl.value.trim())
    if (url.protocol !== 'https:') return '服务器地址必须使用 HTTPS'
  } catch {
    return '请输入有效的服务器地址'
  }
  return ''
}

async function join(): Promise<void> {
  resetFeedback()
  const invalid = validateJoin()
  if (invalid) {
    actionError.value = invalid
    return
  }

  try {
    await store.joinTeam({
      serverUrl: serverUrl.value.trim().replace(/\/$/, ''),
      teamToken: teamToken.value,
      memberName: memberName.value.trim(),
      deviceName: deviceName.value.trim()
    })
    teamToken.value = ''
    showJoin.value = false
    actionMessage.value = '已加入团队'
  } catch (error) {
    actionError.value = userFacingError(error, '加入团队失败')
  } finally {
    // TEAM_TOKEN 只用于本次入组请求，不在 renderer 状态中继续保留。
    teamToken.value = ''
  }
}

async function syncNow(): Promise<void> {
  resetFeedback()
  try {
    await store.syncTeam()
    actionMessage.value = '同步完成'
  } catch (error) {
    actionError.value = userFacingError(error, '团队同步失败')
  }
}

async function saveSchedule(): Promise<void> {
  if (scheduleSaving.value || !status.value) return
  const previous = {
    autoSyncEnabled: status.value.autoSyncEnabled,
    intervalMinutes: status.value.intervalMinutes
  }
  scheduleSaving.value = true
  resetFeedback()
  try {
    await store.updateTeamSettings({
      autoSyncEnabled: autoSyncEnabled.value,
      intervalMinutes: intervalMinutes.value
    })
    if (store.state.team) {
      autoSyncEnabled.value = store.state.team.autoSyncEnabled
      intervalMinutes.value = store.state.team.intervalMinutes
    }
    actionMessage.value = autoSyncEnabled.value
      ? '团队自动同步设置已保存'
      : '已关闭团队自动同步；待上传内容会继续保留'
  } catch (error) {
    autoSyncEnabled.value = previous.autoSyncEnabled
    intervalMinutes.value = previous.intervalMinutes
    actionError.value = userFacingError(error, '团队自动同步设置保存失败')
  } finally {
    scheduleSaving.value = false
  }
}

async function leave(): Promise<void> {
  resetFeedback()
  const confirmed = window.confirm(
    '退出团队后会停止上传和接收团队数据，本机已有文章不会删除。确定退出吗？'
  )
  if (!confirmed) return
  try {
    await store.leaveTeam()
    actionMessage.value = '已退出团队'
  } catch (error) {
    actionError.value = userFacingError(error, '退出团队失败')
  }
}
</script>

<template>
  <section class="team-panel">
    <div class="heading">
      <span>连接状态</span>
      <span v-if="joined" class="state" :class="status?.state">
        <template v-if="status?.state === 'syncing'">同步中</template>
        <template v-else-if="status?.state === 'error'">异常</template>
        <template v-else>已连接</template>
      </span>
      <span v-else class="state not-joined">未加入</span>
    </div>

    <div v-if="store.state.teamLoading && !status" class="placeholder">正在读取团队状态…</div>

    <template v-else-if="joined && status">
      <div class="identity">
        <strong>{{ status.teamName || '当前团队' }}</strong>
        <span>{{ memberLabel ? `${memberLabel} · ` : '' }}{{ deviceLabel }}</span>
      </div>
      <div class="server" :title="status.serverUrl">{{ status.serverUrl }}</div>
      <div class="metrics">
        <span>待上传 {{ status.pendingUploads }}</span>
        <span v-if="status.quarantinedUploads">已隔离 {{ status.quarantinedUploads }}</span>
        <span v-if="status.lastSyncAt">上次 {{ dateTime(status.lastSyncAt) }}</span>
        <span v-else>尚未同步</span>
      </div>
      <div class="schedule-card">
        <div class="schedule-heading">
          <div>
            <strong>自动同步团队数据</strong>
            <p>定时上传本机采集结果，并拉取伙伴的新内容。</p>
          </div>
          <label class="toggle">
            <input
              v-model="autoSyncEnabled"
              type="checkbox"
              :disabled="scheduleSaving"
              @change="saveSchedule"
            />
            <span>{{ autoSyncEnabled ? '已开启' : '已关闭' }}</span>
          </label>
        </div>
        <label class="interval-row">
          <span>同步频率</span>
          <select
            v-model.number="intervalMinutes"
            :disabled="!autoSyncEnabled || scheduleSaving"
            @change="saveSchedule"
          >
            <option :value="1">每 1 分钟（较频繁）</option>
            <option :value="5">每 5 分钟（推荐）</option>
            <option :value="15">每 15 分钟</option>
            <option :value="30">每 30 分钟</option>
            <option :value="60">每 1 小时</option>
            <option :value="240">每 4 小时</option>
            <option :value="1440">每天</option>
          </select>
        </label>
        <p class="schedule-status">{{ scheduleText }}</p>
        <p class="schedule-hint">
          关闭只会暂停定时网络请求，不会退出团队、删除已有内容或停止写入待上传队列。“立即同步”始终可用。
        </p>
      </div>
      <div v-if="statusError" class="error">{{ statusError }}</div>
      <div class="actions">
        <button class="primary" :disabled="busy" @click="syncNow">
          {{ busy ? '同步中…' : '立即同步' }}
        </button>
        <button class="leave" :disabled="busy" @click="leave">退出</button>
      </div>
    </template>

    <template v-else>
      <p class="intro">共享采集结果，团队成员可以分开订阅、共同查看。</p>
      <button class="join-button" :disabled="store.state.teamLoading" @click="openJoin">
        加入团队
      </button>
      <div v-if="store.state.teamError" class="error">{{ store.state.teamError }}</div>
    </template>

    <div v-if="actionMessage" class="message">{{ actionMessage }}</div>
    <div v-if="actionError" class="error">{{ actionError }}</div>

    <div v-if="showJoin" class="mask" @click.self="closeJoin">
      <form class="dialog" @submit.prevent="join">
        <h3>加入团队</h3>
        <p class="dialog-intro">一个服务器就是一个团队。连接后，本机已有及新采集的结果默认上传团队。</p>

        <label for="team-server">服务器地址</label>
        <input
          id="team-server"
          v-model="serverUrl"
          type="url"
          inputmode="url"
          required
          placeholder="https://home.agent-wiki.cn:18038"
        />

        <div class="name-fields">
          <div>
            <label for="team-member">成员名</label>
            <input id="team-member" v-model="memberName" required placeholder="例如：小王" />
          </div>
          <div>
            <label for="team-device">设备名</label>
            <input id="team-device" v-model="deviceName" required placeholder="例如：办公室电脑" />
          </div>
        </div>

        <label for="team-token">服务器 TEAM_TOKEN</label>
        <input
          id="team-token"
          v-model="teamToken"
          type="password"
          autocomplete="new-password"
          required
          placeholder="仅用于本次加入"
        />

        <div class="privacy">
          TEAM_TOKEN 只用于本次入组，不会保存；微信 Cookie、Token、浏览器登录态不会上传。
        </div>
        <div v-if="actionError" class="error dialog-error">{{ actionError }}</div>

        <div class="dialog-actions">
          <button type="button" :disabled="store.state.teamLoading" @click="closeJoin">取消</button>
          <button class="primary" type="submit" :disabled="store.state.teamLoading">
            {{ store.state.teamLoading ? '连接中…' : '加入并开始同步' }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.team-panel {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  font-size: 12px;
}
.heading,
.metrics,
.actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.heading {
  margin-bottom: 7px;
  color: var(--text-dim);
}
.state {
  color: var(--ok);
}
.state.syncing {
  color: var(--accent);
}
.state.error,
.error {
  color: var(--warn);
}
.state.not-joined {
  color: var(--text-dim);
}
.placeholder,
.intro,
.server,
.metrics {
  color: var(--text-dim);
}
.placeholder,
.intro {
  margin: 4px 0 8px;
  line-height: 1.5;
}
.identity {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 3px;
}
.identity strong {
  color: var(--text);
  font-weight: 550;
}
.identity span {
  min-width: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.server {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.metrics {
  margin-top: 5px;
  font-size: 11px;
}
.schedule-card {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}
.schedule-heading,
.interval-row,
.toggle {
  display: flex;
  align-items: center;
}
.schedule-heading,
.interval-row {
  justify-content: space-between;
  gap: 12px;
}
.schedule-heading strong {
  color: var(--text);
  font-size: 12px;
}
.schedule-heading p,
.schedule-status,
.schedule-hint {
  margin: 3px 0 0;
  color: var(--text-dim);
  line-height: 1.5;
}
.toggle {
  flex: 0 0 auto;
  gap: 5px;
}
.interval-row {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
}
.interval-row select {
  width: min(180px, 60%);
}
.schedule-status {
  margin-top: 10px;
  color: var(--accent);
}
.schedule-hint {
  font-size: 11px;
}
.actions {
  margin-top: 8px;
}
.actions .primary {
  flex: 1;
}
.leave {
  color: var(--text-dim);
  border-color: transparent;
  background: transparent;
}
.join-button {
  width: 100%;
}
.message,
.error {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.message {
  color: var(--ok);
}
.mask {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.42);
}
.dialog {
  width: 460px;
  max-width: 100%;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-md);
}
.dialog h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.dialog-intro {
  margin: 0 0 16px;
  color: var(--text-secondary);
}
.dialog label {
  display: block;
  margin: 10px 0 5px;
  color: var(--text-secondary);
}
.name-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.privacy {
  margin-top: 12px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-dim);
  line-height: 1.5;
}
.dialog-error {
  margin-top: 10px;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
@media (max-width: 620px) {
  .schedule-heading,
  .interval-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .interval-row select {
    width: 100%;
  }
}
</style>
