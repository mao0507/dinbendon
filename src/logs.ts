import * as fs from 'fs'
import * as path from 'path'

// 對應 ecosystem.config.js 的 out_file / error_file
export const LOG_FILES = {
  error: path.join(__dirname, '..', 'logs', 'error.log'),
  out: path.join(__dirname, '..', 'logs', 'out.log'),
} as const
export type LogKind = keyof typeof LOG_FILES

const TAIL_BYTES = 64 * 1024 // ponytail: 只讀檔尾 64KB，n 很大時行數會被截短

// 回傳檔案最後 n 行；檔案不存在回 null
export function tailLines(file: string, n: number): string[] | null {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift() // 第一行可能被切半
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.slice(-n)
  } finally {
    fs.closeSync(fd)
  }
}

// Telegram 單則上限 4096 字；超過時從前面砍，保留最新的
export function fitTelegram(text: string, max = 3500): string {
  return text.length <= max ? text : '…\n' + text.slice(text.length - max)
}
