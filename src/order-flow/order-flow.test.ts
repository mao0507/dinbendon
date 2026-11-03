import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OrderFlow, Ui, FlowInput, escapeMarkdown } from './index'
import { BotDatabase } from '../database'
import { DinBenDonClient, Order, OrderDetail, MyOrderItem } from '../dinbendon'

const order: Order = {
  id: 'hash1',
  title: '早餐店',
  shopName: '早餐店',
  deadline: '11/03 10:00',
  organizer: '小明',
  orderUrl: '',
  detailUrl: '',
}
const detail: OrderDetail = {
  order,
  shopRevisionNo: 1,
  categories: [
    {
      name: '蛋餅',
      products: [
        { id: '10', name: '原味蛋餅', variations: [{ id: '100', name: null, price: 30 }] },
      ],
    },
  ],
}

function setup() {
  const submitted: unknown[] = []
  let items: MyOrderItem[] = []
  const client = {
    fetchOpenOrders: async () => [order],
    fetchOrderDetail: async () => detail,
    fetchMyItems: async () => items,
    cancelItem: async () => {},
    submitItem: async (_d: OrderDetail, item: unknown, buyer: string) => {
      submitted.push({ item, buyer })
      items = [
        {
          productName: '原味蛋餅',
          buyerName: buyer,
          qty: 2,
          price: 30,
          comment: null,
          orderItemIds: [501],
          cancelable: true,
        },
      ]
      return true
    },
  } as unknown as DinBenDonClient
  const db = new BotDatabase(':memory:')
  const flow = new OrderFlow({ client, db })

  const shown: string[] = []
  let lastKeyboard: { text: string; callback_data: string }[][] | undefined
  const ui: Ui = {
    async show(text, keyboard) {
      shown.push(text)
      lastKeyboard = keyboard
    },
  }
  const send = (input: FlowInput) => flow.handle(1, input, ui)
  const press = (data: string) => send({ kind: 'callback', data })
  return { send, press, shown, db, submitted, keyboard: () => lastKeyboard }
}

test('完整點餐流程：/orders → 送出 → 記錄 → 取消', async () => {
  const t = setup()

  await t.send({ kind: 'command', name: 'orders' })
  assert.match(t.shown.at(-1)!, /開放中的訂單/)

  await t.press('order:0')
  assert.match(t.shown.at(-1)!, /請選擇分類/)

  await t.press('category:0')
  assert.match(t.shown.at(-1)!, /請選擇餐點/)

  // 單一規格的商品跳過口味，直接選數量
  await t.press('product:10')
  assert.match(t.shown.at(-1)!, /請選擇數量/)

  await t.press('qty:2')
  assert.match(t.shown.at(-1)!, /要加備註嗎/)

  await t.press('note:skip')
  assert.match(t.shown.at(-1)!, /請輸入\*訂購人姓名\*/)

  await t.send({ kind: 'text', text: ' 阿明 ' })
  assert.match(t.shown.at(-1)!, /已送出/)
  assert.deepEqual(t.submitted, [
    { item: { menuItemId: '100', productId: '10', quantity: 2, note: undefined }, buyer: '阿明' },
  ])
  assert.deepEqual([...t.db.getMyItemIds(1, 'hash1')], [501])

  // 查看自己的單，並能取消
  await t.press('my:order')
  const cancelBtn = t.keyboard()!.flat().find((b) => b.callback_data.startsWith('cancel:item:'))
  assert.equal(cancelBtn?.callback_data, 'cancel:item:501')

  await t.press(cancelBtn!.callback_data)
  assert.equal(t.db.listSubmissions()[0].cancelledAt !== null, true)
})

test('escapeMarkdown 跳脫反斜線與保留字元', () => {
  assert.equal(escapeMarkdown('a\\b'), 'a\\\\b')
  assert.equal(escapeMarkdown('1.5-2!'), '1\\.5\\-2\\!')
})

test('無效或過期的 callback 不改變狀態也不輸出', async () => {
  const t = setup()
  await t.press('qty:3')
  await t.press('garbage')
  await t.press('order:9')
  assert.deepEqual(t.shown, [])
})
