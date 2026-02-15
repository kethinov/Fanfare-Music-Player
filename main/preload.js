// this file exposes functions to the renderer that allow it to execute code in the main process
const { contextBridge, ipcRenderer, webUtils } = require('electron')

// support for sending chunks of PCM audio data to the renderer
const pcmChunkCallbacks = new Map()

ipcRenderer.on('convertToPCMAudio-chunk', (event, chunk) => {
  pcmChunkCallbacks.forEach((callback, id) => {
    callback(chunk)
  })
})

// support for sending chunks of picture data from file metadata to the renderer
const pictureChunkCallbacks = new Map()
const pictureCompleteCallbacks = new Map()

ipcRenderer.on('getAudioFilePictures-chunk', (event, payload) => {
  const { file, chunk } = payload
  const cb = pictureChunkCallbacks.get(file)
  if (cb) cb(chunk)
})

ipcRenderer.on('getAudioFilePictures-complete', (event, payload) => {
  const { file } = payload
  const cb = pictureCompleteCallbacks.get(file)
  if (cb) cb(payload)
  pictureChunkCallbacks.delete(file)
  pictureCompleteCallbacks.delete(file)
})

contextBridge.exposeInMainWorld('electron', {
  // exposes method to renderer to allow it to listen to events emitted by the main process
  listen: (channel, callback) => ipcRenderer.on(channel, callback),

  // allows the renderer to get the operating system's accent color for styling purposes
  onAccentColor: (callback) => ipcRenderer.on('setAccentColor', (event, color) => callback(color)),

  // allows the renderer to bring up the confirm quit native dialog
  confirmExit: async (...args) => await ipcRenderer.invoke('confirmExit', ...args),

  // handle OS media keys
  mediaPlayPause: async (...args) => await ipcRenderer.invoke('mediaPlayPause', ...args),
  mediaNextTrack: async (...args) => await ipcRenderer.invoke('mediaNext', ...args),
  mediaPreviousTrack: async (...args) => await ipcRenderer.invoke('mediaPrevious', ...args),

  // allows the renderer to quit the app
  exit: async () => await ipcRenderer.invoke('exit'),

  // allows the renderer to trigger native context menus and supply context as to what was right clicked on
  setContextMenuUIContext: async (...args) => await ipcRenderer.invoke('setContextMenuUIContext', ...args),

  // allows the renderer to send files to the main process
  sendFiles: async (fileList) => {
    const filePaths = []
    for (const i in fileList) filePaths.push(webUtils.getPathForFile(fileList[i]))
    ipcRenderer.invoke('files-dropped', filePaths)
  },

  // allows the renderer to set/get/delete settings stored to electron-store
  store: {
    get: key => ipcRenderer.sendSync('storeGet', { action: 'get', key }),
    set: (key, value) => ipcRenderer.sendSync('storeSet', { action: 'set', key, value }),
    delete: key => ipcRenderer.sendSync('storeDelete', { action: 'delete', key })
  },

  // allows the renderer to execute sql queries against the sqlite database
  db: {
    query: async (...args) => await ipcRenderer.invoke('dbQuery', ...args)
  },

  // allows the renderer to open an open directory dialog
  openDir: async (...args) => await ipcRenderer.invoke('openDir', ...args),

  // allows the renderer to scan a directory for audio files to create the library playlist
  addFilesToLibrary: async (...args) => await ipcRenderer.invoke('addFilesToLibrary', ...args),

  // open file metadata and send it to the renderer, excluding the pictures part of the metadata because it is too big to send over in one ipc transaction
  getAudioFileMetadata: async (params) => {
    const metadata = await ipcRenderer.invoke('getAudioFileMetadata', params) // request metadata from the main process
    return metadata
  },

  // open the pictures part of the file metadata and send it to the renderer in chunks
  getAudioFilePictures: (params, onChunk, onComplete) => {
    const file = params.file
    pictureChunkCallbacks.set(file, onChunk)
    pictureCompleteCallbacks.set(file, (payload) => {
      onComplete(payload)
      pictureChunkCallbacks.delete(file)
      pictureCompleteCallbacks.delete(file)
    })
    return ipcRenderer.invoke('getAudioFilePictures', params)
  },

  // open an audio file, convert it to PCM audio binary, and send the binary to the renderer
  convertToPCMAudio: async (file) => {
    return ipcRenderer.invoke('convertToPCMAudio', file)
  },

  // send a chunk of PCM audio data to the renderer
  onConvertToPCMAudioChunk: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('convertToPCMAudio-chunk', listener)
    return listener // return the listener so it can be removed later
  },

  // signal that assembling all PCM audio chunks is complete
  onConvertToPCMAudioComplete: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('convertToPCMAudio-complete', listener)
    return listener // return the listener so it can be removed later
  }
})
