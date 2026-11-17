import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanDirectory } from '../src/main/services/library'

test('按目录扫描，识别大小写扩展名并按需包含子目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-library-'))
  try {
    await mkdir(join(root, '子目录'))
    await writeFile(join(root, '图片 #1.PNG'), 'fixture')
    await writeFile(join(root, 'notes.txt'), 'ignore')
    await writeFile(join(root, '子目录', 'render.webp'), 'nested')
    const shallow = await scanDirectory(root, false)
    assert.equal(shallow.snapshot.images.length, 1)
    assert.equal(shallow.snapshot.images[0].name, '图片 #1.PNG')
    const deep = await scanDirectory(root, true)
    assert.equal(deep.snapshot.images.length, 2)
    assert.equal(deep.files.size, 2)
    assert.ok(deep.snapshot.images.some((image) => image.directory === '子目录'))
    for (const image of deep.snapshot.images) {
      assert.match(image.id, /^[a-f0-9]{64}$/)
      assert.ok(deep.files.has(image.id))
      assert.ok(image.thumbnailUrl.endsWith('/thumbnail'))
      assert.ok(!image.thumbnailUrl.includes(root))
    }
    const again = await scanDirectory(root, true)
    assert.deepEqual(again.snapshot.images, deep.snapshot.images)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('空目录正常返回，目录消失时明确报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comfy-empty-'))
  try {
    assert.deepEqual((await scanDirectory(root, true)).snapshot.images, [])
    await assert.rejects(scanDirectory(join(root, 'missing'), true))
    const file = join(root, 'file.png')
    await writeFile(file, '')
    await assert.rejects(scanDirectory(file, true), /不是文件夹/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
