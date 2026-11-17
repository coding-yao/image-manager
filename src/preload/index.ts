import { contextBridge, ipcRenderer } from 'electron'
import { channels, type LibraryAPI } from '../shared/library'

const api: LibraryAPI = {
  chooseDirectory: (recursive) => ipcRenderer.invoke(channels.chooseDirectory, recursive),
  refresh: (recursive) => ipcRenderer.invoke(channels.refresh, recursive),
  getMetadata: (imageId) => ipcRenderer.invoke(channels.getMetadata, imageId)
}
contextBridge.exposeInMainWorld('library', api)
