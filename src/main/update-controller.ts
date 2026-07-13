import type { UpdateStatus } from '../shared/ipc'
import { userFacingError } from '../shared/errors'

export interface UpdatePort {
  check(): Promise<void>
  download(): Promise<void>
  install(): void
}

export interface UpdateUi {
  status(value: UpdateStatus): void
  progress(value: number | null): void
  confirmDownload(version: string, currentVersion: string): Promise<boolean>
  confirmInstall(version: string): Promise<boolean>
  showUpToDate(currentVersion: string): Promise<void>
  showBusy(phase: 'checking' | 'downloading'): Promise<void>
  showError(message: string): Promise<void>
}

export class UpdateController {
  private checking = false
  private downloading = false
  private prompting = false
  private interactiveCheck = false
  private availableVersion: string | null = null
  private readyVersion: string | null = null
  private lastFailure: string | null = null

  constructor(
    private readonly port: UpdatePort,
    private readonly ui: UpdateUi,
    private readonly currentVersion: string
  ) {}

  async check(interactive = false): Promise<void> {
    if (this.readyVersion) {
      if (interactive) await this.offerInstall(this.readyVersion)
      return
    }
    if (this.availableVersion) {
      if (interactive) await this.offerDownload(this.availableVersion)
      return
    }
    if (this.checking || this.downloading || this.prompting) {
      if (interactive) await this.ui.showBusy(this.downloading ? 'downloading' : 'checking')
      return
    }

    this.checking = true
    this.interactiveCheck = interactive
    this.lastFailure = null
    this.ui.status({ state: 'checking' })
    try {
      await this.port.check()
    } catch (error) {
      if (this.checking) await this.failed(error)
    }
  }

  async available(version: string): Promise<void> {
    this.checking = false
    this.interactiveCheck = false
    this.availableVersion = version
    this.lastFailure = null
    this.ui.status({ state: 'available', version })
    await this.offerDownload(version)
  }

  async none(): Promise<void> {
    const notify = this.interactiveCheck
    this.checking = false
    this.interactiveCheck = false
    this.availableVersion = null
    this.ui.status({ state: 'none' })
    if (notify) await this.ui.showUpToDate(this.currentVersion)
  }

  progress(percent: number): void {
    const rounded = Math.max(0, Math.min(100, Math.round(percent)))
    this.ui.status({ state: 'downloading', version: this.availableVersion ?? undefined, percent: rounded })
    this.ui.progress(rounded / 100)
  }

  async downloaded(version: string): Promise<void> {
    this.downloading = false
    this.availableVersion = null
    this.readyVersion = version
    this.ui.progress(null)
    this.ui.status({ state: 'ready', version })
    await this.offerInstall(version)
  }

  async failed(error: unknown): Promise<void> {
    const message = userFacingError(error, '检查更新失败')
    if (!this.checking && !this.downloading && this.lastFailure === message) return
    const notify = this.interactiveCheck || this.downloading
    this.checking = false
    this.downloading = false
    this.interactiveCheck = false
    this.ui.progress(null)
    this.ui.status({ state: 'error', message })
    this.lastFailure = message
    if (notify) await this.ui.showError(message)
  }

  installNow(): void {
    if (this.readyVersion) this.port.install()
  }

  private async offerDownload(version: string): Promise<void> {
    if (this.prompting || this.downloading) return
    this.prompting = true
    let accepted = false
    try {
      accepted = await this.ui.confirmDownload(version, this.currentVersion)
    } finally {
      this.prompting = false
    }
    if (!accepted) return

    this.availableVersion = version
    this.downloading = true
    this.ui.status({ state: 'downloading', version, percent: 0 })
    this.ui.progress(0)
    try {
      await this.port.download()
    } catch (error) {
      if (this.downloading) await this.failed(error)
    }
  }

  private async offerInstall(version: string): Promise<void> {
    if (this.prompting) return
    this.prompting = true
    try {
      if (await this.ui.confirmInstall(version)) this.port.install()
    } finally {
      this.prompting = false
    }
  }
}
