import type { CollectionScheduleState } from '../../shared/collection'
import { userFacingError } from '../../shared/errors'
import type { CollectResult } from './collector'
import type { CollectionBatchResult } from './collection-runner'

export interface CollectionRunFeedback {
  state: Extract<CollectionScheduleState, 'error' | 'paused'>
  message: string
}

function sourceFailureMessage(result: CollectResult): string {
  if (result.status === 'no_account') return '没有可用的公众号账号'
  if (result.status === 'rate_limited') return '已触发请求频率保护，请稍后再试'
  if (result.status === 'auth_expired') return '公众号账号登录状态已失效'
  return userFacingError(result.message, '采集失败')
}

/** 把后台批次结果收敛成可直接展示的中文反馈；成功时返回 null。 */
export function automaticCollectionFeedback(
  batch: CollectionBatchResult
): CollectionRunFeedback | null {
  if (batch.status === 'skipped_busy') {
    return {
      state: 'paused',
      message: '已有采集或维护任务在运行，本轮自动采集已跳过。'
    }
  }

  const failures = batch.results.filter(({ result }) => result.status !== 'ok')
  if (failures.length === 0 && batch.metadataErrors.length === 0) return null

  const parts: string[] = []
  if (failures.length > 0) {
    const samples = failures
      .slice(0, 3)
      .map(({ source, result }) => `${source.name}（${sourceFailureMessage(result)}）`)
    parts.push(`本轮有 ${failures.length} 个信源未完成：${samples.join('；')}`)
    if (failures.length > samples.length) parts.push(`另有 ${failures.length - samples.length} 个未展开`)
  }
  if (batch.skippedSourceIds.length > 0) {
    parts.push(`另有 ${batch.skippedSourceIds.length} 个公众号因账号不可用而跳过`)
  }
  if (batch.metadataErrors.length > 0) {
    parts.push(`有 ${batch.metadataErrors.length} 个信源的最近采集时间未能保存`)
  }

  return { state: 'error', message: `${parts.join('；')}。` }
}
