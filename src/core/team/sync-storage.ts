import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { Paths } from '../paths'
import type { TeamArticleUpload } from '../../shared/team'
import { teamUploadValidationError } from './sync-validation'

function eventFileName(eventId: string): string {
  return `${encodeURIComponent(eventId)}.json`
}

function ackFileName(eventId: string): string {
  return `${encodeURIComponent(eventId)}.ack`
}

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

export class TeamSyncStorage {
  constructor(private paths: Paths) {
    mkdirSync(paths.teamOutbox, { recursive: true })
    mkdirSync(paths.teamAcked, { recursive: true })
    mkdirSync(paths.teamQuarantine, { recursive: true })
  }

  enqueue(item: TeamArticleUpload): boolean {
    if (this.isAcknowledged(item.eventId) || this.isQuarantined(item.eventId)) return false
    const path = join(this.paths.teamOutbox, eventFileName(item.eventId))
    if (existsSync(path)) return false
    writeAtomic(path, item)
    return true
  }

  pendingCount(): number {
    return this.outboxFiles().length
  }

  quarantineCount(): number {
    if (!existsSync(this.paths.teamQuarantine)) return 0
    return readdirSync(this.paths.teamQuarantine).filter((name) => name.endsWith('.json')).length
  }

  quarantine(item: TeamArticleUpload, reason: string): void {
    mkdirSync(this.paths.teamQuarantine, { recursive: true })
    const target = join(this.paths.teamQuarantine, eventFileName(item.eventId))
    if (!existsSync(target)) {
      writeAtomic(target, { quarantinedAt: Date.now(), reason, item })
    }
    rmSync(join(this.paths.teamOutbox, eventFileName(item.eventId)), { force: true })
  }

  readBatch(limit = 100, maxBytes = 6 * 1024 * 1024): TeamArticleUpload[] {
    const result: TeamArticleUpload[] = []
    let bytes = Buffer.byteLength('{"items":[]}')
    for (const file of this.outboxFiles()) {
      if (result.length >= limit) break
      const path = join(this.paths.teamOutbox, file)
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        const invalid = teamUploadValidationError(parsed)
        if (invalid) {
          this.quarantineOutboxFile(file, parsed, invalid)
          continue
        }
        const item = parsed as TeamArticleUpload
        if (this.isAcknowledged(item.eventId)) {
          rmSync(path, { force: true })
          continue
        }
        const itemBytes = Buffer.byteLength(JSON.stringify(item)) + (result.length > 0 ? 1 : 0)
        if (result.length > 0 && bytes + itemBytes > maxBytes) break
        // 首项即使超过建议批次大小也单独返回，让服务端给出明确的单文章尺寸错误。
        result.push(item)
        bytes += itemBytes
      } catch {
        // 隔离损坏事件供人工排查，避免它永久挡住队列后面的正常事件。
        this.quarantineOutboxFile(file)
      }
    }
    return result
  }

  acknowledge(eventIds: string[]): void {
    for (const eventId of eventIds) {
      const ack = join(this.paths.teamAcked, ackFileName(eventId))
      if (!existsSync(ack)) writeAtomic(ack, { eventId })
      rmSync(join(this.paths.teamOutbox, eventFileName(eventId)), { force: true })
    }
  }

  cursor(): number {
    if (!existsSync(this.paths.teamState)) return 0
    try {
      const parsed = JSON.parse(readFileSync(this.paths.teamState, 'utf8')) as { cursor?: unknown }
      return Number.isInteger(parsed.cursor) && Number(parsed.cursor) >= 0 ? Number(parsed.cursor) : 0
    } catch {
      return 0
    }
  }

  saveCursor(cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('团队同步 cursor 无效')
    mkdirSync(this.paths.team, { recursive: true })
    writeAtomic(this.paths.teamState, { cursor })
  }

  reset(): void {
    rmSync(this.paths.teamOutbox, { recursive: true, force: true })
    rmSync(this.paths.teamAcked, { recursive: true, force: true })
    rmSync(this.paths.teamQuarantine, { recursive: true, force: true })
    rmSync(this.paths.teamState, { force: true })
    mkdirSync(this.paths.teamOutbox, { recursive: true })
    mkdirSync(this.paths.teamAcked, { recursive: true })
    mkdirSync(this.paths.teamQuarantine, { recursive: true })
  }

  private outboxFiles(): string[] {
    if (!existsSync(this.paths.teamOutbox)) return []
    return readdirSync(this.paths.teamOutbox)
      .filter((name) => name.endsWith('.json'))
      .sort()
  }

  private isAcknowledged(eventId: string): boolean {
    return existsSync(join(this.paths.teamAcked, ackFileName(eventId)))
  }

  private quarantineOutboxFile(file: string, item?: unknown, reason = '事件 JSON 损坏'): void {
    mkdirSync(this.paths.teamQuarantine, { recursive: true })
    const source = join(this.paths.teamOutbox, file)
    let target = join(this.paths.teamQuarantine, file)
    if (existsSync(target)) target = join(this.paths.teamQuarantine, `${Date.now()}-${file}`)
    if (item === undefined) renameSync(source, target)
    else {
      writeAtomic(target, { quarantinedAt: Date.now(), reason, item })
      rmSync(source, { force: true })
    }
  }

  isQuarantined(eventId: string): boolean {
    return existsSync(join(this.paths.teamQuarantine, eventFileName(eventId)))
  }
}
