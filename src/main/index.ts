import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { channels } from '../shared/library'
import { scanDirectory } from './services/library'
import { readImageMetadata } from './services/metadata'

protocol.registerSchemesAsPrivileged([
  { scheme: 'comfy-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let mainWindow: BrowserWindow | null = null
let root: string | null = null
let files = new Map<string, string>()
let scanning = false
const thumbnails = new Map<string, Promise<Buffer>>()
let activeThumbnails = 0
const thumbnailQueue: Array<() => void> = []

async function thumbnail(path: string): Promise<Buffer> {
  if (activeThumbnails >= 4) await new Promise<void>((resolve) => thumbnailQueue.push(resolve))
  activeThumbnails++
  try {
    const image = process.platform === 'linux'
      ? nativeImage.createFromPath(path).resize({ width: 360 })
      : await nativeImage.createThumbnailFromPath(path, { width: 360, height: 360 })
    if (image.isEmpty()) throw new Error('无法解码图片')
    return image.toJPEG(82)
  } finally {
    activeThumbnails--
    thumbnailQueue.shift()?.()
  }
}

function registerImageProtocol(): void {
  protocol.handle('comfy-image', async (request) => {
    const url = new URL(request.url)
    const match = /^\/([a-f0-9]{64})\/(thumbnail|original)$/.exec(url.pathname)
    if (request.method !== 'GET' || url.hostname !== 'library' || !match) return new Response(null, { status: 400 })
    const [, id, kind] = match
    const path = files.get(id)
    if (!path) return new Response(null, { status: 404 })
    try {
      if (kind === 'original') return await net.fetch(pathToFileURL(path).href)
      let pending = thumbnails.get(id)
      if (!pending) {
        pending = thumbnail(path)
        thumbnails.set(id, pending)
        if (thumbnails.size > 128) thumbnails.delete(thumbnails.keys().next().value!)
      }
      return new Response(new Uint8Array(await pending), { headers: { 'Content-Type': 'image/jpeg' } })
    } catch {
      thumbnails.delete(id)
      return new Response(null, { status: 422 })
    }
  })
}

function registerLibraryIPC(): void {
  async function load(nextRoot: string, recursive: boolean) {
    const result = await scanDirectory(nextRoot, recursive)
    root = result.snapshot.root
    files = result.files
    thumbnails.clear()
    return result.snapshot
  }

  ipcMain.handle(channels.getMetadata, async (event, imageId: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('无效的调用来源')
    }
    if (typeof imageId !== 'string' || !/^[a-f0-9]{64}$/.test(imageId)) throw new Error('无效的图片 ID')
    const path = files.get(imageId)
    if (!path) throw new Error('图片不在当前目录索引中，请刷新后重试')
    return readImageMetadata(path)
  })

  for (const channel of [channels.chooseDirectory, channels.refresh]) {
    ipcMain.handle(channel, async (event, recursive: unknown) => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('无效的调用来源')
      }
      if (typeof recursive !== 'boolean') throw new Error('无效的目录扫描选项')
      if (scanning) throw new Error('正在读取目录，请稍候')
      scanning = true
      try {
        if (channel === channels.refresh) return root ? await load(root, recursive) : null
        const selection = await dialog.showOpenDialog(mainWindow, {
          title: '选择 ComfyUI 图片目录', properties: ['openDirectory'], defaultPath: root ?? undefined
        })
        if (selection.canceled || !selection.filePaths[0]) return null
        return await load(selection.filePaths[0], recursive)
      } finally {
        scanning = false
      }
    })
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360, height: 900, minWidth: 940, minHeight: 640,
    title: 'Comfy Image Manager', backgroundColor: '#101213', autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.on('closed', () => { mainWindow = null })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerImageProtocol()
  registerLibraryIPC()
  createWindow()
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
