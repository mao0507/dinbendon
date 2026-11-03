import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Access } from './access'
import { BotDatabase } from './database'

function setup(adminUserId: number | null = 1) {
  const db = new BotDatabase(':memory:', true)
  return { db, access: new Access({ db, adminUserId }) }
}

test('白名單開啟：未授權被拒，授權後放行，撤銷後再被拒', () => {
  const { db, access } = setup()
  assert.equal(access.isAllowed(2), false)
  db.authorizeUser(2)
  assert.equal(access.isAllowed(2), true)
  db.revokeUser(2)
  assert.equal(access.isAllowed(2), false)
})

test('白名單關閉：所有人放行', () => {
  const { db, access } = setup()
  db.setWhitelistEnabled(false)
  assert.equal(access.isAllowed(2), true)
})

test('管理員不需授權也放行，且只有管理員是 admin', () => {
  const { access } = setup(1)
  assert.equal(access.isAllowed(1), true)
  assert.equal(access.isAdmin(1), true)
  assert.equal(access.isAdmin(2), false)
})

test('沒有設定管理員時沒人是 admin', () => {
  const { access } = setup(null)
  assert.equal(access.isAdmin(1), false)
  assert.equal(access.isAllowed(1), false)
})
