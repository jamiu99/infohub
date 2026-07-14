/** 可迁移的内容资料库状态；账号、团队 token 等私有状态不在其中。 */
export interface DataLibraryMigrationView {
  status: 'success' | 'failed'
  sourceRoot: string
  targetRoot?: string
  completedAt: number
  message: string
}

export interface DataLibraryStatus {
  root: string
  defaultRoot: string
  outputsPath: string
  customized: boolean
  migration: DataLibraryMigrationView | null
}

export type DataLibraryMoveResult =
  | { state: 'cancelled' }
  | { state: 'restarting'; targetRoot: string }
