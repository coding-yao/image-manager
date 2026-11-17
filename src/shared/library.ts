/** 只在此处定义跨进程契约，避免界面依赖 Node / Electron。 */
export interface ImageEntry {
  id: string
  name: string
  relativePath: string
  directory: string
  size: number
  modifiedAt: number
  thumbnailUrl: string
  previewUrl: string
}

export interface LibrarySnapshot {
  root: string
  recursive: boolean
  images: ImageEntry[]
  warnings: string[]
}

export interface WorkflowNode {
  id: string
  type: string
  title: string
  source: 'prompt' | 'workflow' | 'both'
  inputs: Record<string, unknown>
  widgets?: unknown
}

export interface ImageMetadata {
  status: 'ok' | 'empty' | 'unsupported' | 'invalid'
  message: string
  width?: number
  height?: number
  prompt?: Record<string, unknown>
  workflow?: Record<string, unknown>
  raw: { prompt?: string; workflow?: string }
  nodes: WorkflowNode[]
  warnings: string[]
}

export interface LibraryAPI {
  chooseDirectory(recursive: boolean): Promise<LibrarySnapshot | null>
  refresh(recursive: boolean): Promise<LibrarySnapshot | null>
  getMetadata(imageId: string): Promise<ImageMetadata>
}

export const channels = {
  chooseDirectory: 'library:choose-directory',
  refresh: 'library:refresh',
  getMetadata: 'library:get-metadata'
} as const
