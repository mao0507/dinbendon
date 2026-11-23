import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import { BAD_ACCESS_CODE, DinBenDonClient, NO_ACCESS_CODE } from './dinbendon'

function respond(config: InternalAxiosRequestConfig, status: number, data: unknown): Promise<AxiosResponse> {
  const response = { data, status, statusText: '', headers: {}, config } as AxiosResponse
  if (status < 300) return Promise.resolve(response)
  return Promise.reject(new AxiosError('fail', AxiosError.ERR_BAD_REQUEST, config, null, response))
}

/** 假 Worker：只認通關碼 9453，記下每個請求的 headers。 */
function setup(code: string | null = '9453') {
  const seen: InternalAxiosRequestConfig[] = []
  const state = { code }
  const adapter = async (config: InternalAxiosRequestConfig) => {
    seen.push(config)
    if (config.headers.get('X-Access-Code') !== '9453') return respond(config, 401, { error: 'bad code' })
    if (config.url?.endsWith('/expand-for-buyer')) {
      return respond(config, 200, {
        data: {
          items: [
            { id: 1, buyerName: 'Mao', productFullName: '蛋餅', comment: null, price: 40 },
            { id: 2, buyerName: 'Mao', productFullName: '蛋餅', comment: null, price: 40 },
            { id: 3, buyerName: 'Amy', productFullName: '奶茶', comment: '微糖', price: 25, paid: true },
          ],
        },
      })
    }
    if (config.url?.endsWith('/cancel-item')) return respond(config, 400, { error: '已結單' })
    return respond(config, 200, {
      data: [
        { orderHashId: 'abc', shopName: '早餐店', expireDate: null, originator: '週二早餐', inProgress: true },
        { orderHashId: 'old', shopName: '早餐店', expireDate: null, originator: '週一早餐', inProgress: false },
      ],
    })
  }
  const client = new DinBenDonClient({ getAccessCode: () => state.code, adapter })
  return { client, seen, state }
}

test('帶通關碼、Origin、owner key，拆 { data } 並只留開放中的團', async () => {
  const { client, seen } = setup()
  const orders = await client.fetchOpenOrders()
  assert.deepEqual(orders.map((o) => o.id), ['abc'])
  const h = seen[0].headers
  assert.equal(h.get('X-Access-Code'), '9453')
  assert.equal(h.get('Origin'), 'https://w1323wwww-wq.github.io')
  assert.equal(h.get('X-Owner-Key'), 'tg-bot')
})

test('取消帶使用者的 owner key；網站錯誤訊息直接丟出', async () => {
  const { client, seen } = setup()
  await assert.rejects(client.cancelItem('abc', [1], 42), /已結單/)
  assert.equal(seen[0].headers.get('X-Owner-Key'), 'tg-42')
})

test('expand-for-buyer 合併同人同品項，已付款不可取消', async () => {
  const { client } = setup()
  const items = await client.fetchMyItems('abc')
  assert.deepEqual(
    items.map((i) => [i.buyerName, i.qty, i.orderItemIds, i.cancelable]),
    [['Mao', 2, [1, 2], true], ['Amy', 1, [3], false]],
  )
})

test('沒設定通關碼：不打網站；碼錯：回失效訊息', async () => {
  const { client, seen, state } = setup(null)
  await assert.rejects(client.fetchOpenOrders(), { message: NO_ACCESS_CODE })
  assert.equal(seen.length, 0)
  state.code = '0000'
  await assert.rejects(client.fetchOpenOrders(), { message: BAD_ACCESS_CODE })
})

test('verifyAccessCode：用指定的碼試打，不看目前設定', async () => {
  const { client } = setup(null)
  assert.equal(await client.verifyAccessCode('9453'), true)
  assert.equal(await client.verifyAccessCode('0000'), false)
})
