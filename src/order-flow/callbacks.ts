// callback_data 的編碼與解碼集中在此，兩邊格式只會一起改。

export type Callback =
  | { type: 'order'; idx: number }
  | { type: 'category'; idx: number }
  | { type: 'product'; id: string }
  | { type: 'variation'; id: string }
  | { type: 'qty'; n: number }
  | { type: 'noteSkip' }
  | { type: 'myOrder' }
  | { type: 'cancelItems'; ids: number[] }
  | { type: 'backCat' }
  | { type: 'backProducts' }
  | { type: 'cancel' }
  | { type: 'orders' }
  | { type: 'back' }
  | { type: 'lastName' }

export const cb = {
  order: (idx: number) => `order:${idx}`,
  category: (idx: number) => `category:${idx}`,
  product: (id: string) => `product:${id}`,
  variation: (id: string) => `variation:${id}`,
  qty: (n: number) => `qty:${n}`,
  noteSkip: 'note:skip',
  myOrder: 'my:order',
  cancelItems: (ids: number[]) => `cancel:item:${ids.join(',')}`,
  backCat: 'back:cat',
  backProducts: 'back:products',
  cancel: 'cancel',
  orders: 'orders',
  back: 'back',
  lastName: 'name:last',
}

export function decodeCallback(data: string): Callback | null {
  if (data === cb.noteSkip) return { type: 'noteSkip' }
  if (data === cb.myOrder) return { type: 'myOrder' }
  if (data === cb.backCat) return { type: 'backCat' }
  if (data === cb.backProducts) return { type: 'backProducts' }
  if (data === cb.cancel) return { type: 'cancel' }
  if (data === cb.orders) return { type: 'orders' }
  if (data === cb.back) return { type: 'back' }
  if (data === cb.lastName) return { type: 'lastName' }
  if (data.startsWith('cancel:item:')) {
    const ids = data
      .slice('cancel:item:'.length)
      .split(',')
      .map(Number)
      .filter((n) => !isNaN(n))
    return { type: 'cancelItems', ids }
  }

  const sep = data.indexOf(':')
  if (sep < 0) return null
  const key = data.slice(0, sep)
  const val = data.slice(sep + 1)
  switch (key) {
    case 'order':
      return { type: 'order', idx: parseInt(val) }
    case 'category':
      return { type: 'category', idx: parseInt(val) }
    case 'qty':
      return { type: 'qty', n: parseInt(val) }
    case 'product':
      return { type: 'product', id: val }
    case 'variation':
      return { type: 'variation', id: val }
    default:
      return null
  }
}
