// various audio file management functionality
const { ipcMain } = require('electron')
const { Worker } = require('worker_threads')
const fs = require('fs')
const path = require('path')

// handle renderer sending files to the main process
ipcMain.handle('files-dropped', async (event, paths) => {
  await global.mainWindow.webContents.send('updateUI', { action: 'addDraggedFilesToLibrary', params: paths })
})

// handle importing a new audio file library
const TAGLIB_ACCESSORS = require('../models/getTaglibAccessors')
ipcMain.handle('addFilesToLibrary', async (event, filesToAdd, chunk, filesAdded) => await addFilesToLibrary(filesToAdd, chunk, filesAdded))

async function addFilesToLibrary (filesToAdd, chunk, filesAdded) {
  return new Promise((resolve, reject) => {
    // accepts a string representing a dir or an array of strings representing either files or dirs
    let fileList = []
    if (typeof filesToAdd === 'object') {
      for (const file of filesToAdd) {
        if (fs.lstatSync(file).isDirectory()) {
          const thisList = fs.readdirSync(file, { recursive: true }).map(f => path.join(file, f)) // list of absolute paths
          fileList = fileList.concat(thisList)
        } else {
          fileList.push(file)
        }
      }
    } else {
      fileList = fs.readdirSync(filesToAdd, { recursive: true }).map(f => path.join(filesToAdd, f)) // list of absolute paths
    }

    chunk = chunk || 0
    filesAdded = filesAdded || []

    // process 1111 files at a time before reporting progress back to the renderer
    const chunkSize = 1111
    const chunks = []
    for (let i = 0; i < fileList.length; i += chunkSize) chunks.push(fileList.slice(i, i + chunkSize))

    // delegate file processing to a worker thread so the app doesn't freeze when importing thousands of files
    const worker = new Worker(path.join(__dirname, '../models/addFilesToLibrary.js'))
    worker.postMessage({ chunks, chunk })

    // when the worker is done
    worker.on('message', (newFiles) => {
      filesAdded.push(...newFiles)

      // when we're done processing every file
      if (chunk === chunks.length - 1) {
        if (filesAdded.length > 0) { // do nothing if no valid files were added
          let sql = 'insert into library (file_path, date_added'
          TAGLIB_ACCESSORS.forEach(key => {
            if (key !== 'pictures') {
              sql += `, ${key}`
            }
          })
          sql += ') values (?, ?'
          TAGLIB_ACCESSORS.forEach(key => {
            if (key !== 'pictures') {
              sql += ', ?'
            }
          })
          sql += ')'
          global.db.query(sql, filesAdded)
        }
        resolve({
          done: true,
          chunks,
          filesAdded
        })
      } else {
        resolve({
          done: false,
          chunks,
          filesAdded
        })
      }
      worker.terminate()
    })
  })
}

// handle get file metadata calls from renderer, except for pictures
const getAudioFileMetadata = require('../models/getAudioFileMetadata')
ipcMain.handle('getAudioFileMetadata', async (event, params) => getAudioFileMetadata(params))

// handle get file picture metadata from renderer
const getAudioFilePictures = require('../models/getAudioFilePictures')
ipcMain.handle('getAudioFilePictures', async (event, params) => {
  const pictureRequestId = params.pictureRequestId // use pictureRequestId from renderer
  const pictureMetadata = getAudioFilePictures(params)
  const pictures = pictureMetadata.pictures || []

  const json = JSON.stringify({ pictures })
  const CHUNK_SIZE = 256 * 1024

  for (let offset = 0; offset < json.length; offset += CHUNK_SIZE) {
    const chunk = json.slice(offset, offset + CHUNK_SIZE)
    event.sender.send('getAudioFilePictures-chunk', { pictureRequestId, chunk })
  }

  event.sender.send('getAudioFilePictures-complete', { pictureRequestId, file: params.file })
  return { pictureRequestId }
})

// convert file to pcm data
const { spawn } = require('child_process')
const ffmpegStatic = require('ffmpeg-static')
const ffmpegPath = ffmpegStatic.includes('app.asar') ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked') : ffmpegStatic // if running from asar, replace with unpacked path
ipcMain.handle('convertToPCMAudio', async (event, filePath) => {
  // filePath = path.join(process.cwd(), 'sample_audio/White Noise.m4a') // uncomment this to test this method against a hardcoded, small file

  const chunks = []
  const CHUNK_SIZE = 262144 // 256KB chunks (65536 float32 samples)

  if (filePath.endsWith('.spc')) {
    // initialize SPCPlayer module
    const SPCPlayer = await require('spc-converter')()

    // convert SPC file to PCM Buffer
    const pcmBuffer = await SPCPlayer.renderToPCMBuffer(filePath)

    // send pcmBuffer as a single chunk since it will always be less than 256kb
    event.sender.send('convertToPCMAudio-chunk', { filePath, chunk: pcmBuffer })
    event.sender.send('convertToPCMAudio-complete', { filePath })
  } else {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn(ffmpegPath, [
        '-i', filePath,
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        '-ar', '48000', // hardcoded to 48000 hz, which is the Web Audio API's default sampling rate in the renderer process
        '-ac', '2', // hardcoded to 2 channel stereo; if we change this, then the de-interleaving code in the renderer process will likely need to be updated since it is hardcoded to assume 2 channel audio; see https://github.com/Otherworldly-Media/Fanfare-Music-Player/issues/99 for more details
        'pipe:1'
      ])

      ffmpeg.stdout.on('data', chunk => {
        chunks.push(chunk)

        // send chunk via ipc when we have enough data
        if (Buffer.concat(chunks).length >= CHUNK_SIZE) {
          const buffer = Buffer.concat(chunks)
          const toSend = buffer.subarray(0, CHUNK_SIZE)
          event.sender.send('convertToPCMAudio-chunk', { filePath, chunk: toSend })

          // keep remainder for next chunk
          if (buffer.length > CHUNK_SIZE) {
            chunks.length = 0
            chunks.push(buffer.subarray(CHUNK_SIZE))
          } else {
            chunks.length = 0
          }
        }
      })

      ffmpeg.on('error', reject)
      ffmpeg.on('close', code => {
        if (code === 0) {
          // send final chunk
          if (chunks.length > 0) {
            event.sender.send('convertToPCMAudio-chunk', { filePath, chunk: Buffer.concat(chunks) })
          }
          event.sender.send('convertToPCMAudio-complete', { filePath })
          resolve()
        } else {
          reject(new Error('FFmpeg failed'))
        }
      })
    })
  }
})
