'use strict'

const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  timeout: 30000
})

function fail(code, message) { return { ok: false, error: { code, message } } }

exports.main = async (event = {}) => {
  if (String(event.action || '') !== 'create') return fail('VALIDATION', '未知小程序码操作')
  const scene = String(event.scene || '').trim()
  if (!/^qr_login_[a-f0-9]{22}$/i.test(scene)) return fail('VALIDATION', '小程序码场景参数无效')
  try {
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page: 'pages/onboarding/index',
      checkPath: false,
      envVersion: String(event.envVersion || 'trial'),
      width: 430
    })
    const buffer = result && result.buffer
    if (!buffer) return fail('WECHAT_MINI_QR_EMPTY', '微信没有返回小程序码图片')
    return {
      ok: true,
      data: {
        contentType: String(result.contentType || 'image/png').split(';')[0],
        bufferBase64: Buffer.from(buffer).toString('base64')
      }
    }
  } catch (error) {
    const message = String(error && (error.errMsg || error.message) || error)
    if (/INVALID_WX_ACCESS_TOKEN|invalid wx openapi access_token|501001/i.test(message)) {
      return fail('WECHAT_MINI_QR_NOT_ASSOCIATED', '当前 CloudBase 环境尚未收到有效的微信 OpenAPI 访问令牌，请检查环境所属小程序和 /wxa/getwxacodeunlimit 权限。')
    }
    return fail('WECHAT_MINI_QR_FAILED', message.slice(0, 500))
  }
}
