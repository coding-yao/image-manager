import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { MAX_TEXT_BYTES, readImageMetadata } from '../src/main/services/metadata'

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const prompt = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '森林中的猫 🌲', clip: ['4', 1] }, _meta: { title: '正向提示词' } } }
const workflow = { version: 0.4, nodes: [{ id: 6, type: 'CLIPTextEncode', title: '编辑器标题', widgets_values: ['森林中的猫 🌲'] }, { id: 10, type: 'Note', widgets_values: ['备注'] }], links: [[1, 4, 1, 6, 0, 'CLIP']] }

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const payload = Buffer.concat([Buffer.from(type), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(payload))
  return Buffer.concat([length, payload, checksum])
}

function text(key: string, value: string, type = 'tEXt', compressed = false): Buffer {
  const content = Buffer.from(value)
  return chunk(type, Buffer.concat([Buffer.from(key + '\0'),
    type === 'iTXt' ? Buffer.from([compressed ? 1 : 0, 0, 0, 0]) : type === 'zTXt' ? Buffer.from([0]) : Buffer.alloc(0),
    type === 'zTXt' || compressed ? deflateSync(content) : content]))
}

function png(...texts: Buffer[]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(640, 0)
  ihdr.writeUInt32BE(480, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  // 解析器不解码像素，测试只构造容器和文本块。
  return Buffer.concat([signature, chunk('IHDR', ihdr), ...texts, chunk('IEND', Buffer.alloc(0))])
}

async function parse(data: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), 'comfy-metadata-'))
  const path = join(directory, '原图.png')
  try { await writeFile(path, data); return await readImageMetadata(path) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('合并 prompt/workflow，保留原始数据、自定义节点、中文与连接', async () => {
  const result = await parse(png(text('prompt', JSON.stringify(prompt)), text('workflow', JSON.stringify(workflow))))
  assert.equal(result.status, 'ok')
  assert.equal(result.width, 640)
  assert.equal(result.height, 480)
  assert.deepEqual(result.prompt, prompt)
  assert.deepEqual(result.workflow, workflow)
  assert.equal(result.nodes[0].title, '正向提示词')
  assert.equal(result.nodes[0].source, 'both')
  assert.deepEqual(result.nodes[0].inputs.clip, ['4', 1])
  assert.equal(result.nodes[1].source, 'workflow')
})

for (const [type, compressed] of [['zTXt', false], ['iTXt', false], ['iTXt', true]] as const) {
  test(`支持 ${type} compressed=${compressed}`, async () => {
    const result = await parse(png(text('prompt', JSON.stringify(prompt), type, compressed)))
    assert.equal(result.status, 'ok')
    assert.equal(result.nodes[0].inputs.text, '森林中的猫 🌲')
  })
}

test('只有 workflow 时也显示节点和 widgets；版本 0 不丢失', async () => {
  const result = await parse(png(text('workflow', JSON.stringify({ ...workflow, version: 0 }))))
  assert.equal(result.status, 'ok')
  assert.equal(result.workflow?.version, 0)
  assert.equal(result.nodes[0].title, '编辑器标题')
  assert.deepEqual(result.nodes[0].widgets, ['森林中的猫 🌲'])
})

test('某个 JSON 损坏不影响另一个；保留坏 JSON 供检查', async () => {
  const result = await parse(png(text('prompt', '{broken'), text('workflow', JSON.stringify(workflow))))
  assert.equal(result.status, 'ok')
  assert.equal(result.raw.prompt, '{broken')
  assert.match(result.warnings.join(), /prompt JSON 无效/)
  assert.equal(result.nodes.length, 2)
})

test('区分无数据、非 PNG、错误 JSON 与错误结构', async () => {
  assert.equal((await parse(png())).status, 'empty')
  assert.equal((await parse(Buffer.from('not a png'))).status, 'unsupported')
  for (const value of ['{broken', 'null', '[]', '"string"', '{"bad":{"inputs":{}}}']) {
    assert.equal((await parse(png(text('prompt', value)))).status, 'invalid')
  }
  assert.equal((await parse(png(text('workflow', '{}')))).status, 'invalid')
})

test('检查文本 CRC、块长度、截断和缺失 IEND', async () => {
  const badCrc = text('prompt', JSON.stringify(prompt))
  badCrc[badCrc.length - 1] ^= 1
  assert.match((await parse(png(badCrc))).warnings.join(), /校验失败/)
  const badLength = text('prompt', '{}')
  badLength.writeUInt32BE(0xffffffff)
  assert.equal((await parse(png(badLength))).status, 'invalid')
  assert.equal((await parse(png().subarray(0, -12))).status, 'invalid')
  assert.equal((await parse(png().subarray(0, -1))).status, 'invalid')
})

test('读取位于像素块之后的元数据，并拒绝解压超限与无效压缩', async () => {
  assert.equal((await parse(png(chunk('IDAT', Buffer.from('skip pixels')), text('prompt', JSON.stringify(prompt))))).status, 'ok')
  const huge = text('prompt', 'x'.repeat(MAX_TEXT_BYTES + 1), 'zTXt')
  assert.equal((await parse(png(huge))).status, 'invalid')
  assert.equal((await parse(png(chunk('zTXt', Buffer.from('prompt\0\0not-zlib'))))).status, 'invalid')
})

test('重复字段明确提示，不把 __proto__ 元数据当成对象原型', async () => {
  const result = await parse(png(text('__proto__', '{"polluted":true}'), text('prompt', '{}'), text('prompt', JSON.stringify(prompt))))
  assert.equal(result.status, 'ok')
  assert.equal(result.nodes.length, 1)
  assert.match(result.warnings.join(), /重复/)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('过深的 JSON 给出提示，避免 IPC 或界面递归溢出', async () => {
  const nested = '['.repeat(80) + '0' + ']'.repeat(80)
  const result = await parse(png(text('prompt', `{"6":{"class_type":"Custom","inputs":{"value":${nested}}}}`)))
  assert.equal(result.status, 'invalid')
  assert.match(result.warnings.join(), /层级/)
})
