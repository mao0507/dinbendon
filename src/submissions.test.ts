import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Submissions } from './submissions'
import { BotDatabase } from './database'
import { DinBenDonClient, MyOrderItem, Order, OrderDetail } from './dinbendon'

const order: Order = {
  id: 'hash1',
  title: '店',
  shopName: '店',
  deadline: '',
  organizer: '小明',
  orderUrl: '',
  detailUrl: '',
}
const detail: OrderDetail = { order, categories: [], shopRevisionNo: 1 }
const item = { menuItemId: '100', productId: '10', name: '蛋餅', quantity: 1 }

const row = (buyerName: string, ids: number[]): MyOrderItem => ({
  productName: '蛋餅',
  buyerName,
  qty: 1,
  price: 30,
  comment: null,
  orderItemIds: ids,
  cancelable: true,
})

function setup(opts: { listFails?: boolean; accept?: boolean; othersMidSubmit?: boolean; apiBuyerName?: string } = {}) {
  let items: MyOrderItem[] = [row('別人', [1])]
  let calls = 0
  const cancelled: number[][] = []
  const client = {
    fetchMyItems: async () => {
      calls++
      if (opts.listFails && calls === 1) throw new Error('boom')
      return items
    },
    submitItem: async (_d: unknown, _i: unknown, buyer: string) => {
      if (opts.accept === false) return false
      items = [
        ...items,
        ...(opts.othersMidSubmit ? [row('路人', [8])] : []),
        row(opts.apiBuyerName ?? buyer, [9]),
      ]
      return true
    },
    cancelItem: async (_o: string, ids: number[]) => void cancelled.push(ids),
  } as unknown as DinBenDonClient
  const db = new BotDatabase(':memory:')
  return { subs: new Submissions({ client, db }), db, cancelled }
}

test('place：只記錄姓名相符的新增品項，不含既有與別人同時送的', async () => {
  const t = setup({ othersMidSubmit: true })
  const r = await t.subs.place(1, detail, item, '阿明')
  assert.deepEqual(r, { ok: true, recorded: [9] })
  assert.deepEqual([...t.db.getMyItemIds(1, 'hash1')], [9])
})

test('place：送出前快照失敗則中止，不送出', async () => {
  const t = setup({ listFails: true })
  const r = await t.subs.place(1, detail, item, '阿明')
  assert.equal(r.ok, false)
  assert.equal(t.db.getMyItemIds(1, 'hash1').size, 0)
})

test('place：網站拒絕回 Rejected', async () => {
  const r = await setup({ accept: false }).subs.place(1, detail, item, '阿明')
  assert.equal(r.ok, false)
})

test('place：姓名對不上時退回記錄全部新增 id', async () => {
  const t = setup({ apiBuyerName: '阿明(改)' })
  const r = await t.subs.place(1, detail, item, '阿明')
  assert.deepEqual(r, { ok: true, recorded: [9] })
})

test('cancel：只取消自己的 id，沒有則不呼叫網站', async () => {
  const t = setup()
  await t.subs.place(1, detail, item, '阿明')

  const bad = await t.subs.cancel(1, 'hash1', [1])
  assert.equal(bad.ok, false)
  assert.deepEqual(t.cancelled, [])

  const ok = await t.subs.cancel(1, 'hash1', [1, 9])
  assert.equal(ok.ok, true)
  assert.deepEqual(t.cancelled, [[9]])
  assert.notEqual(t.db.listSubmissions()[0].cancelledAt, null)
})

test('mine：區分全部與自己的', async () => {
  const t = setup()
  await t.subs.place(1, detail, item, '阿明')
  const m = await t.subs.mine(1, 'hash1')
  assert.equal(m.all.length, 2)
  assert.deepEqual(m.mine.map((i) => i.orderItemIds), [[9]])
})
