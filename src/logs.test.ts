import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { tailLines, fitTelegram } from './logs'

test('tailLines 回傳最後 n 行、忽略結尾空行', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'log-')), 'a.log')
  fs.writeFileSync(file, 'a\nb\nc\nd\n')
  assert.deepEqual(tailLines(file, 2), ['c', 'd'])
  assert.deepEqual(tailLines(file, 10), ['a', 'b', 'c', 'd'])
})

test('tailLines 檔案不存在回 null', () => {
  assert.equal(tailLines('/nonexistent/x.log', 5), null)
})

test('fitTelegram 超長時保留尾端', () => {
  assert.equal(fitTelegram('abc', 10), 'abc')
  assert.equal(fitTelegram('abcdef', 3), '…\ndef')
})
