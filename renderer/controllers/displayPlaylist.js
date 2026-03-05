module.exports = (app) => {
  app.route('/displayPlaylist').get(async (req, res) => {
    res.target = '#content > article'
    let members = ''
    let playlist = req.body?.playlist
    if (!playlist || playlist === 'Library') {
      playlist = 'Library'
      window.viewing = 'library'
      if (window.library && window.library.length <= 0) window.library = null
      window.library = window.library || await require('models/getLibrary')()
      window.currentPlaylist = null
      members = window.library
    } else {
      window.viewing = 'playlist'
      window.currentPlaylist = playlist
      members = await require('models/getPlaylistMembers')({ playlist })
    }
    const libraryIsEmpty = await require('models/isLibraryEmpty')()
    if (libraryIsEmpty) {
      document.querySelectorAll('form[action="/displayPlaylist"] span').forEach(async (el) => {
        if (el.innerHTML === playlist) el.parentNode.classList.add('selected')
        else el.parentNode.classList.remove('selected')
      })
      await app.triggerRoute({ route: '/addFilesToLibrary' })
    } else {
      res.render('displayFiles', {}, async () => {
        await require('ui/renderAudioFileList')(members)
        document.querySelectorAll('form[action="/displayPlaylist"] span').forEach(async (el) => {
          if (el.innerHTML === playlist) el.parentNode.classList.add('selected')
          else el.parentNode.classList.remove('selected')
        })
      })
    }
  })
}
