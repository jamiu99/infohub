/**
 * 把 Electron 的同步 before-quit 事件与异步的数据收尾桥接起来。
 * 多个退出来源（关窗、菜单、自动更新）共用同一个 preparation，避免重复关闭 Store。
 */
export class GracefulShutdownCoordinator {
  private preparation: Promise<void> | null = null
  private allowed = false

  constructor(private readonly prepare: () => Promise<void>) {}

  isQuitAllowed(): boolean {
    return this.allowed
  }

  async prepareAndAllowQuit(): Promise<void> {
    if (this.allowed) return
    if (!this.preparation) {
      this.preparation = this.prepare().catch((error) => {
        // 允许调用方在可恢复错误后再次尝试，而不是永久复用 rejected Promise。
        this.preparation = null
        throw error
      })
    }
    await this.preparation
    this.allowed = true
  }
}
