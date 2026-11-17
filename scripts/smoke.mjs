import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { crc32 } from 'node:zlib'

function withMetadata(png) {
  const value = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: '<img src=x onerror=alert(1)> 森林中的猫', clip: ['4', 1] }, _meta: { title: '正向提示词' } } })
  const data = Buffer.from('tEXtprompt\0' + value)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length - 4)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(data))
  return Buffer.concat([png.subarray(0, -12), length, data, checksum, png.subarray(-12)])
}

const fixture = await mkdtemp(join(tmpdir(), 'comfy-smoke-'))
let app
try {
  await mkdir(join(fixture, '子目录'))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64')
  await writeFile(join(fixture, '样例 #1.png'), withMetadata(png))
  await writeFile(join(fixture, '子目录', 'nested.png'), png)
  await writeFile(join(fixture, 'broken.png'), 'broken image')
  await mkdir(resolve('artifacts'), { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const executablePath = process.argv[2] ? resolve(process.argv[2]) : undefined
  app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('heading', { name: '为你的灵感，留一个位置' }).waitFor()
  await page.screenshot({ path: 'artifacts/empty-state.png' })
  assert.equal(await page.evaluate(() => typeof window.library.chooseDirectory), 'function')
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, fixture)
  await page.getByRole('button', { name: '＋ 选择目录' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.image-card').length === 3)
  await page.waitForFunction(() => document.querySelector('.image-card img')?.naturalWidth > 0)
  await page.getByText('无法生成缩略图', { exact: false }).waitFor()
  await page.getByRole('button', { name: '查看 样例 #1.png', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.waitForFunction(() => document.querySelector('.preview-image img')?.naturalWidth === 1)
  await page.getByText('已读取原图内嵌的 ComfyUI 数据。').waitFor()
  await page.locator('.workflow-node summary').click()
  await page.getByText('<img src=x onerror=alert(1)> 森林中的猫', { exact: true }).waitFor()
  assert.equal(await page.locator('.metadata-panel img').count(), 0)
  await page.getByRole('textbox', { name: '搜索工作流节点' }).fill('森林中的猫')
  assert.equal(await page.locator('.workflow-node').count(), 1)
  await page.getByRole('textbox', { name: '搜索工作流节点' }).fill('不存在的节点')
  await page.getByText('没有匹配的节点。').waitFor()
  await page.getByRole('textbox', { name: '搜索工作流节点' }).fill('')
  await page.getByText('原始 prompt JSON', { exact: true }).click()
  await page.locator('.raw-data pre').waitFor()
  await page.screenshot({ path: 'artifacts/image-preview.png' })
  await page.keyboard.press('Escape')
  await page.getByRole('checkbox', { name: '包含子目录' }).uncheck()
  await page.waitForFunction(() => document.querySelectorAll('.image-card').length === 2)
  await page.getByRole('checkbox', { name: '包含子目录' }).check()
  await page.waitForFunction(() => document.querySelectorAll('.image-card').length === 3)
  await page.getByRole('textbox', { name: '按文件名或路径筛选' }).fill('nested')
  await page.waitForFunction(() => document.querySelectorAll('.image-card').length === 1)
  await page.getByRole('textbox', { name: '按文件名或路径筛选' }).fill('不存在')
  await page.getByRole('heading', { name: '没有匹配的图片' }).waitFor()
  await page.getByRole('button', { name: '清空筛选' }).click()
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  await page.getByRole('button', { name: '＋ 选择目录' }).click()
  assert.equal(await page.locator('.image-card').count(), 3)
  await rm(join(fixture, '子目录', 'nested.png'))
  await page.getByRole('button', { name: '↻ 刷新' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.image-card').length === 2)
  const status = await app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, `comfy-image://library/${'0'.repeat(64)}/original`)
  assert.equal(status, 404)
  const rejected = await page.evaluate(async () => {
    try { await window.library.getMetadata('0'.repeat(64)); return false } catch { return true }
  })
  assert.equal(rejected, true)
  assert.deepEqual(errors, [])
  console.log('Electron smoke passed: 图片浏览、工作流解析、节点搜索、原始 JSON、安全文本渲染与 IPC 限制。')
} finally {
  await app?.close()
  await rm(fixture, { recursive: true, force: true })
}
