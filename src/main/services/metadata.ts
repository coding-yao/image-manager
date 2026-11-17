import { open } from 'node:fs/promises'
import { inflate } from 'node:zlib'
import { promisify } from 'node:util'
import type { ImageMetadata, WorkflowNode } from '../../shared/library'

const unzip = promisify(inflate)
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
export const MAX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_TEXT = 16 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkJsonComplexity(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let count = 0
  while (pending.length) {
    const current = pending.pop()!
    if (++count > 100000 || current.depth > 64) throw new Error('JSON 层级或字段数量超出解析限制')
    if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 })
    }
  }
}

/** 合并执行图与编辑器图；不依赖具体自定义节点，也不猜测 widgets 的参数名称。 */
export function normalizeNodes(prompt?: Record<string, unknown>, workflow?: Record<string, unknown>): WorkflowNode[] {
  const nodes = new Map<string, WorkflowNode>()
  if (Array.isArray(workflow?.nodes)) {
    for (const node of workflow.nodes) {
      if (!record(node) || (typeof node.id !== 'number' && typeof node.id !== 'string')) continue
      const id = String(node.id)
      nodes.set(id, {
        id, type: typeof node.type === 'string' ? node.type : 'Unknown',
        title: typeof node.title === 'string' ? node.title : record(node._meta) && typeof node._meta.title === 'string' ? node._meta.title : '',
        source: 'workflow', inputs: {}, widgets: node.widgets_values
      })
    }
  }
  for (const [id, node] of Object.entries(prompt ?? {})) {
    if (!record(node)) continue
    const previous = nodes.get(id)
    nodes.set(id, {
      id, type: typeof node.class_type === 'string' ? node.class_type : previous?.type ?? 'Unknown',
      title: record(node._meta) && typeof node._meta.title === 'string' ? node._meta.title : previous?.title ?? '',
      source: previous ? 'both' : 'prompt', inputs: record(node.inputs) ? node.inputs : {}, widgets: previous?.widgets
    })
  }
  return [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

// 元数据也属于不可信的文件内容。校验文本块 CRC，并限制压缩数据解压后的大小。
function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function decodeText(data: Buffer): string {
  // PNG tEXt/zTXt 使用 Latin-1；兼容部分工具写入的 UTF-8 文本。
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { return data.toString('latin1') }
}

async function textChunk(type: string, data: Buffer): Promise<{ key: string; text: string } | null> {
  const separator = data.indexOf(0)
  if (separator < 1 || separator > 79) throw new Error('无效的文本关键字')
  const key = data.subarray(0, separator).toString('latin1')
  if (key !== 'prompt' && key !== 'workflow') return null
  let content = data.subarray(separator + 1)
  if (type === 'zTXt') {
    if (content[0] !== 0) throw new Error('不支持的文本压缩方法')
    content = await unzip(content.subarray(1), { maxOutputLength: MAX_TEXT_BYTES })
  } else if (type === 'iTXt') {
    const flag = content[0]
    if ((flag !== 0 && flag !== 1) || content[1] !== 0) throw new Error('无效的国际文本压缩标记')
    const languageEnd = content.indexOf(0, 2)
    const translatedEnd = languageEnd < 0 ? -1 : content.indexOf(0, languageEnd + 1)
    if (translatedEnd < 0) throw new Error('国际文本字段不完整')
    content = content.subarray(translatedEnd + 1)
    if (flag === 1) content = await unzip(content, { maxOutputLength: MAX_TEXT_BYTES })
    return { key, text: new TextDecoder('utf-8', { fatal: true }).decode(content) }
  }
  return { key, text: decodeText(content) }
}

/** 按块读取原文件，跳过 IDAT 像素数据，不把整张原图读入内存。 */
export async function readImageMetadata(path: string): Promise<ImageMetadata> {
  const result: ImageMetadata = { status: 'empty', message: '图片未包含 ComfyUI prompt / workflow 元数据。', raw: {}, nodes: [], warnings: [] }
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    async function read(position: number, length: number): Promise<Buffer> {
      const data = Buffer.alloc(length)
      let offset = 0
      while (offset < length) {
        const { bytesRead } = await file.read(data, offset, length - offset, position + offset)
        if (!bytesRead) throw new Error('PNG 文件被截断或读取期间已发生变化')
        offset += bytesRead
      }
      return data
    }
    if (size < 8 || !(await read(0, 8)).equals(signature)) {
      return { ...result, status: 'unsupported', message: '当前仅支持 PNG 原图中的 ComfyUI 元数据；此文件不是 PNG。' }
    }
    let position = 8
    let count = 0
    let total = 0
    let ended = false
    while (position < size) {
      if (++count > 20000) throw new Error('PNG 数据块数量超出解析限制')
      if (size - position < 12) throw new Error('PNG 数据块头不完整')
      const header = await read(position, 8)
      const length = header.readUInt32BE(0)
      const type = header.toString('ascii', 4, 8)
      if (length > 0x7fffffff || position + length + 12 > size) throw new Error('PNG 数据块长度无效或文件被截断')
      if (count === 1 && (type !== 'IHDR' || length !== 13)) throw new Error('PNG 缺少有效 IHDR')
      if (type === 'IHDR') {
        if (length !== 13 || count !== 1) throw new Error('PNG IHDR 无效')
        const data = await read(position + 8, 13)
        result.width = data.readUInt32BE(0)
        result.height = data.readUInt32BE(4)
        if (!result.width || !result.height) throw new Error('PNG 尺寸无效')
      }
      if (['tEXt', 'zTXt', 'iTXt'].includes(type)) {
        total += length
        if (length > MAX_TEXT_BYTES || total > MAX_TOTAL_TEXT) throw new Error('PNG 文本数据超出解析大小限制')
        const data = await read(position + 8, length + 4)
        if (crc32(Buffer.concat([header.subarray(4), data.subarray(0, length)])) !== data.readUInt32BE(length)) {
          result.warnings.push(`${type} 文本块校验失败，已跳过。`)
        } else {
          try {
            const text = await textChunk(type, data.subarray(0, length))
            if (text) {
              total += Buffer.byteLength(text.text)
              if (total > MAX_TOTAL_TEXT) throw new Error('文本解压后总量超出限制')
              const key = text.key as 'prompt' | 'workflow'
              if (result.raw[key] !== undefined) result.warnings.push(`${key} 重复，使用最后一个文本块。`)
              result.raw[key] = text.text
            }
          } catch (error) {
            result.warnings.push(`${type} 解析失败：${error instanceof Error ? error.message : '未知错误'}`)
          }
        }
      }
      position += length + 12
      if (type === 'IEND') {
        if (length !== 0) throw new Error('PNG IEND 无效')
        ended = true
        break
      }
    }
    if (!ended) throw new Error('PNG 缺少 IEND，文件可能不完整')
    for (const key of ['prompt', 'workflow'] as const) {
      if (result.raw[key] === undefined) continue
      try {
        const parsed: unknown = JSON.parse(result.raw[key]!)
        checkJsonComplexity(parsed)
        if (!record(parsed) || (key === 'workflow' && !Array.isArray(parsed.nodes))) throw new Error('数据结构不符合 ComfyUI 格式')
        if (key === 'prompt' && Object.values(parsed).some((node) => !record(node) || typeof node.class_type !== 'string')) {
          throw new Error('prompt 节点缺少 class_type')
        }
        result[key] = parsed
      } catch (error) {
        result.warnings.push(`${key} JSON 无效：${error instanceof Error ? error.message : '无法解析'}`)
      }
    }
    result.nodes = normalizeNodes(result.prompt, result.workflow)
    if (result.prompt || result.workflow) {
      result.status = 'ok'
      result.message = '已读取原图内嵌的 ComfyUI 数据。'
    } else if (result.warnings.length || result.raw.prompt !== undefined || result.raw.workflow !== undefined) {
      result.status = 'invalid'
      result.message = '元数据损坏或格式不受支持，无法解析工作流。'
    }
    return result
  } catch (error) {
    // 文件结构错误时不把半份工作流当作成功结果。
    return { ...result, status: 'invalid', message: error instanceof Error ? error.message : 'PNG 解析失败', nodes: [] }
  } finally {
    await file.close()
  }
}
