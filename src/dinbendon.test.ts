import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { DinBenDonClient, LoginError } from './dinbendon'

function respond(
  config: InternalAxiosRequestConfig,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): Promise<AxiosResponse> {
  const response = { data, status, statusText: '', headers, config } as AxiosResponse
  if (status < 300) return Promise.resolve(response)
  return Promise.reject(new AxiosError('fail', AxiosError.ERR_BAD_REQUEST, config, null, response))
}

/** 假網站：登入換發新 token，只認最新的 token。 */
function setup(cooldownMs = 30_000) {
  const server = { valid: '', issued: 0, loginOk: true, logins: 0 }
  const adapter = async (config: InternalAxiosRequestConfig) => {
    if (config.url === '/auth/login') {
      server.logins++
      if (!server.loginOk) return respond(config, 200, { data: null, error: '帳密錯誤' })
      server.valid = `tok${++server.issued}`
      return respond(config, 200, { data: {}, error: null }, { 'x-dbd-new-token': server.valid })
    }
    if (config.headers.get('Authorization') !== `Bearer ${server.valid}`) {
      return respond(config, 401, {})
    }
    return respond(config, 200, { data: [] })
  }
  const client = new DinBenDonClient({ username: 'u', password: 'p', cooldownMs, adapter })
  return { client, server }
}

test('延遲登入：建構時不登入，並發呼叫只登入一次', async () => {
  const { client, server } = setup()
  assert.equal(server.logins, 0)
  await Promise.all([client.fetchOpenOrders(), client.fetchOpenOrders()])
  assert.equal(server.logins, 1)
})

test('token 失效：並發的 401 只重登一次，且各自重試成功', async () => {
  const { client, server } = setup()
  await client.fetchOpenOrders()
  server.valid = 'revoked' // 伺服器端讓 tok1 失效
  const results = await Promise.all([
    client.fetchOpenOrders(),
    client.fetchOpenOrders(),
    client.fetchOpenOrders(),
  ])
  assert.deepEqual(results, [[], [], []])
  assert.equal(server.logins, 2)
})

test('登入失敗：丟 LoginError，冷卻期間不再打登入端點，冷卻後恢復', async () => {
  const { client, server } = setup(50)
  server.loginOk = false

  const first = await client.fetchOpenOrders().catch((e: unknown) => e)
  assert.ok(first instanceof LoginError)
  assert.match((first as LoginError).message, /聯絡管理員/)
  assert.equal(((first as LoginError).detail as Error).message, '帳密錯誤')
  assert.equal(server.logins, 1)

  await assert.rejects(client.fetchOpenOrders(), LoginError)
  assert.equal(server.logins, 1) // 冷卻中，沒有再登入

  await new Promise((r) => setTimeout(r, 60))
  server.loginOk = true
  assert.deepEqual(await client.fetchOpenOrders(), [])
  assert.equal(server.logins, 2)
})
