const WECHAT_LOGIN_HOST = 'mp.weixin.qq.com'

export type WechatQrPageState = 'ready' | 'failed' | 'timeout'

export interface WechatQrPageResult {
  state: WechatQrPageState
  attempts: number
}

export function isWechatLoginUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === WECHAT_LOGIN_HOST
  } catch {
    return false
  }
}

/**
 * 微信公众平台会优先展示账号/快捷登录，后者在 Electron 中还可能等待
 * Local Network Access 权限而保持空白。这个脚本通过页面自己的 Vue 点击事件
 * 切到传统二维码，不读取任何输入框内容。
 */
export function buildWechatQrLoginScript(): string {
  return `(() => new Promise((resolve) => {
    let attempts = 0;
    let switchedMode = false;
    let switchedFallback = false;

    const visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };

    const click = (el) => {
      if (!el || typeof el.click !== 'function') return false;
      el.click();
      return true;
    };

    const tick = () => {
      attempts += 1;

      const accountPanel = document.querySelector('.login__type__container__account');
      if (!switchedMode && visible(accountPanel)) {
        switchedMode = click(document.querySelector('.login__type__container__select-type__scan'));
      }

      const qr = document.querySelector('.login__type__container__scan__qrcode');
      const src = qr ? (qr.currentSrc || qr.getAttribute('src') || '') : '';
      const imageLoaded = qr && typeof qr.complete === 'boolean'
        ? qr.complete && qr.naturalWidth > 0
        : Boolean(src);
      if (visible(qr) && src && !src.includes('default_qrcode') && imageLoaded) {
        resolve({ state: 'ready', attempts });
        return;
      }

      const failed = Array.from(document.querySelectorAll('.login__type__container__scan_mask__info'))
        .some((el) => (el.textContent || '').includes('二维码加载失败'));
      if (failed) {
        resolve({ state: 'failed', attempts });
        return;
      }

      if (!switchedFallback) {
        const fallback = Array.from(document.querySelectorAll('.login__type__container__scan a'))
          .find((el) => (el.textContent || '').trim() === '扫码登录');
        switchedFallback = click(fallback);
      }

      if (attempts >= 50) {
        resolve({ state: 'timeout', attempts });
        return;
      }
      setTimeout(tick, 200);
    };

    tick();
  }))()`
}
