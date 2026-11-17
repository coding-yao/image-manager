import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { ImageEntry, LibrarySnapshot } from '../../shared/library'

const extensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])

export interface ScannedLibrary {
  snapshot: LibrarySnapshot
  files: Map<string, string>
}

/** 跳过符号链接，不跟随链接离开用户选择的目录。 */
export async function scanDirectory(rootPath: string, recursive: boolean): Promise<ScannedLibrary> {
  const root = await realpath(rootPath)
  if (!(await stat(root)).isDirectory()) throw new Error('所选路径不是文件夹')
  const images: ImageEntry[] = []
  const files = new Map<string, string>()
  const warnings: string[] = []
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (directory === root) throw error
      warnings.push(`无法读取目录：${relative(root, directory)}`)
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (recursive) pending.push(path)
        continue
      }
      if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) continue
      try {
        const info = await stat(path)
        const id = createHash('sha256').update(path).update(String(info.mtimeMs)).update(String(info.size)).digest('hex')
        files.set(id, path)
        images.push({
          id, name: basename(path), relativePath: relative(root, path),
          directory: relative(root, dirname(path)), size: info.size, modifiedAt: info.mtimeMs,
          thumbnailUrl: `comfy-image://library/${id}/thumbnail`,
          previewUrl: `comfy-image://library/${id}/original`
        })
      } catch {
        warnings.push(`无法读取文件：${relative(root, path)}`)
      }
    }
  }
  images.sort((a, b) => b.modifiedAt - a.modifiedAt || a.relativePath.localeCompare(b.relativePath))
  return { snapshot: { root, recursive, images, warnings }, files }
}
