// 归一化注册表：按信源 type 找对应的 RawItem → Article 归一化函数。
// 加新信源 = 注册一个 normalizer，collector 不动。见 docs/process.md。
import type { RawItem, Article, Source } from '../../shared/contract'

export type Normalizer = (item: RawItem, source: Source) => Article

const registry = new Map<string, Normalizer>()

export function registerNormalizer(type: string, fn: Normalizer): void {
  registry.set(type, fn)
}

export function getNormalizer(type: string): Normalizer | undefined {
  return registry.get(type)
}
