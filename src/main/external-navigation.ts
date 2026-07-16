import { isHttpUrl } from '../shared/url'

export interface FrameNavigation {
  url: string
  isMainFrame: boolean
}

/** 公众号 srcdoc 内发生的真实页面导航必须离开 App，主 renderer 导航不在这里处理。 */
export function shouldOpenFrameExternally(navigation: FrameNavigation): boolean {
  return !navigation.isMainFrame && isHttpUrl(navigation.url)
}
