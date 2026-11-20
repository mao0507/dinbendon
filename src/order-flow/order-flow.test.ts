import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OrderFlow, Ui, FlowInput, escapeMarkdown } from './index'
import { BotDatabase } from '../database'
import { Submissions } from '../submissions'
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
  const ctl = { accept: true, gate: Promise.resolve() as Promise<void> }
  const client = {
    fetchOpenOrders: async () => [order],
    fetchOrderDetail: async () => detail,
    fetchMyItems: async () => items,
    cancelItem: async () => {},
    submitItem: async (_d: OrderDetail, item: unknown, buyer: string) => {
      await ctl.gate
      if (!ctl.accept) return false
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
  const flow = new OrderFlow({ client, submissions: new Submissions({ client, db }) })

  const shown: string[] = []
  let lastKeyboard: { text: string; callback_data: string }[][] | undefined
  // 模仿 makeUi：command/text 新送一則（新 id），callback 編輯按鈕所在訊息
  let nextId = 1
  let lastMsgId = 0
  const makeUi = (messageId?: number): Ui => {
    let current = messageId
    return {
      async show(text, keyboard) {
        shown.push(text)
        lastKeyboard = keyboard
        current ??= nextId++
        lastMsgId = current
        return current
      },
    }
  }
  const send = (input: FlowInput) =>
    flow.handle(1, input, makeUi(input.kind === 'callback' ? input.messageId : undefined))
  const press = (data: string) => send({ kind: 'callback', data })
  // 從指定訊息按按鈕（預設最後顯示的那則），會做過期檢查
  const click = (data: string, messageId = lastMsgId) =>
    send({ kind: 'callback', data, messageId })
  const toBuyerName = async () => {
    await send({ kind: 'command', name: 'orders' })
    for (const d of ['order:0', 'category:0', 'product:10', 'qty:2', 'note:skip']) await press(d)
  }
  return {
    send, press, click, shown, db, submitted, ctl, toBuyerName,
    keyboard: () => lastKeyboard,
    buttons: () => (lastKeyboard ?? []).flat().map((b) => b.callback_data),
    msgId: () => lastMsgId,
  }
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

test('送出被拒絕時保留待送品項，可重打姓名重試', async () => {
  const t = setup()
  await t.toBuyerName()

  t.ctl.accept = false
  await t.send({ kind: 'text', text: '阿明' })
  assert.match(t.shown.at(-1)!, /送出失敗/)
  assert.match(t.shown.at(-1)!, /重新輸入/)
  assert.equal(t.submitted.length, 0)

  t.ctl.accept = true
  await t.send({ kind: 'text', text: '阿明' })
  assert.match(t.shown.at(-1)!, /已送出/)
  assert.equal(t.submitted.length, 1)
})

test('送出進行中再傳姓名不會重送', async () => {
  const t = setup()
  await t.toBuyerName()

  let release!: () => void
  t.ctl.gate = new Promise<void>((r) => (release = r))
  const first = t.send({ kind: 'text', text: '阿明' })
  await t.send({ kind: 'text', text: '阿明' }) // 送出中，被忽略
  release()
  await first

  assert.equal(t.submitted.length, 1)
})

test('第二次點餐可直接用上次的姓名', async () => {
  const t = setup()
  await t.toBuyerName()
  assert.ok(!t.buttons().includes('name:last'))
  await t.send({ kind: 'text', text: '阿明' })

  for (const d of ['category:0', 'product:10', 'qty:1', 'note:skip']) await t.press(d)
  assert.ok(t.buttons().includes('name:last'))
  await t.press('name:last')
  assert.match(t.shown.at(-1)!, /已送出/)
  assert.equal((t.submitted[1] as { buyer: string }).buyer, '阿明')
})

test('沒有開放訂單或離開流程時提供開啟訂單按鈕', async () => {
  const t = setup()
  await t.send({ kind: 'command', name: 'cancel' })
  assert.deepEqual(t.buttons(), ['orders'])
  await t.press('orders')
  assert.match(t.shown.at(-1)!, /開放中的訂單/)
})

test('舊訊息的按鈕視為過期，開啟訂單按鈕永遠可用', async () => {
  const t = setup()
  await t.send({ kind: 'command', name: 'orders' })
  const oldMsg = t.msgId()
  await t.send({ kind: 'command', name: 'orders' }) // 新的一則
  await t.click('order:0', oldMsg)
  assert.match(t.shown.at(-1)!, /已過期/)
  assert.deepEqual(t.buttons(), ['orders'])

  await t.click('orders', oldMsg)
  assert.match(t.shown.at(-1)!, /開放中的訂單/)
  await t.click('order:0') // 剛重開的那則有效
  assert.match(t.shown.at(-1)!, /請選擇分類/)
})

test('上一步：姓名 → 備註 → 數量 → 餐點；中途取消回餐點列表', async () => {
  const t = setup()
  await t.toBuyerName()
  await t.press('back')
  assert.match(t.shown.at(-1)!, /要加備註嗎/)
  await t.press('back')
  assert.match(t.shown.at(-1)!, /請選擇數量/)
  await t.press('back')
  assert.match(t.shown.at(-1)!, /請選擇餐點/)

  await t.press('product:10')
  await t.press('cancel')
  assert.match(t.shown.at(-1)!, /請選擇餐點/)
})
