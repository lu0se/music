import './preload' // must be first
import './sentry'
import { app, BrowserWindow, BrowserWindowConstructorOptions, shell } from 'electron'
import { release } from 'os'
import { join } from 'path'
import log from './log'
import { initIpcMain, lyricWin } from './ipcMain'
import { createTray, YPMTray } from './tray'
import { IpcChannels } from '@/shared/IpcChannels'
import { createTaskbar, Thumbar } from './windowsTaskbar'
import { createMenu } from './menu'
import { appName, isDev, isLinux, isMac, isWindows } from './env'
import store from './store'
import initAppServer from './appServer/appServer'
import { bindingKeyboardShortcuts } from './keyboardShortcuts'

log.info('[electron] index.ts')

class Main {
  win: BrowserWindow | null = null
  tray: YPMTray | null = null
  thumbar: Thumbar | null = null

  constructor() {
    log.info('[index] Main process start')
    // Disable GPU Acceleration for Windows 7
    if (release().startsWith('6.1')) app.disableHardwareAcceleration()

    // Set application name for Windows 10+ notifications
    if (process.platform === 'win32') app.setAppUserModelId(app.getName())

    // Make sure the app only run on one instance
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      process.exit(0)
    }
    // create IPFS Server
    app.whenReady().then(async () => {
      log.info('[index] App ready')

      await initAppServer()
      this.createWindow()
      this.handleAppEvents()
      this.handleWindowEvents()
      this.createTray()
      this.disableCacheInDev()
      createMenu(this.win!.webContents)
      bindingKeyboardShortcuts(this.win!.webContents, undefined, this.win!)
      this.createThumbar()
      initIpcMain(this.win, this.tray, this.thumbar, store)
      // this.initDevTools()
    })
  }

  initDevTools() {
    if (!isDev || !this.win) return

    // Install devtool extension
    const {
      default: installExtension,
      REACT_DEVELOPER_TOOLS,
      // eslint-disable-next-line @typescript-eslint/no-var-requires
    } = require('electron-devtools-installer')
    installExtension(REACT_DEVELOPER_TOOLS.id).catch((err: unknown) =>
      log.info('An error occurred: ', err)
    )

    this.win.webContents.openDevTools()
  }

  createTray() {
    if (isWindows || isLinux || isDev) {
      this.tray = createTray(this.win!)
    }
  }

  createThumbar() {
    if (isWindows) this.thumbar = createTaskbar(this.win!)
  }
  // disable cache in dev
  disableCacheInDev() {
    if (isDev) {
    }
  }

  createWindow() {
    const options: BrowserWindowConstructorOptions = {
      title: appName,
      webPreferences: {
        preload: join(__dirname, 'rendererPreload.js'),
        // for lyrics effect
        webSecurity: false,
        sandbox: false
      },
      width: store.get('window.width'),
      height: store.get('window.height'),
      minWidth: 1240,
      minHeight: 800,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 18, y: 20 },
      frame: false,
      fullscreenable: true,
      resizable: true,
      transparent: true,
      backgroundColor: 'rgba(0, 0, 0, 0)',
      show: false,
    }
    if (store.get('window')) {
      options.x = store.get('window.x')
      options.y = store.get('window.y')
    }
    this.win = new BrowserWindow(options)

    // Web server, load the web server to the electron
    const url = `http://localhost:${process.env.ELECTRON_WEB_SERVER_PORT}`
    this.win.loadURL(url)

    // Make all links open with the browser, not with the application
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      const allowUrlList = ['github.com']
      const urlIsAllowed = allowUrlList.some(allowUrl => url.includes(allowUrl))

      if (urlIsAllowed) {
        shell.openExternal(url)
      }

      return { action: 'deny' }
    })

    // 减少显示空白窗口的时间
    this.win.once('ready-to-show', () => {
      this.win && this.win.show()
    })

    this.disableCORS()
  }

  disableCORS() {
    if (!this.win) return

    const addCORSHeaders = (headers: Record<string, string | string[]>) => {
      if (
        headers['Access-Control-Allow-Origin']?.[0] !== '*' &&
        headers['access-control-allow-origin']?.[0] !== '*'
      ) {
        headers['Access-Control-Allow-Origin'] = ['*']
      }
      return headers
    }

    this.win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      const { requestHeaders, url } = details
      addCORSHeaders(requestHeaders)

      // 不加这几个 header 的话，使用 axios 加载 YouTube 音频会很慢
      if (
        url.includes('googlevideo.com') ||
        url.includes('github.com') ||
        url.includes('music.126.net')
      ) {
        requestHeaders['Sec-Fetch-Mode'] = 'no-cors'
        requestHeaders['Sec-Fetch-Dest'] = 'audio'
        requestHeaders['Range'] = 'bytes=0-'
      }

      callback({ requestHeaders })
    })

    this.win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const { responseHeaders, url } = details
      if (url.includes('sentry.io')) {
        callback({ responseHeaders })
        return
      }
      if (responseHeaders) {
        addCORSHeaders(responseHeaders)
      }
      callback({ responseHeaders })
    })
  }

  handleWindowEvents() {
    if (!this.win) return

    // Window maximize and minimize
    this.win.on('maximize', () => {
      this.win && this.win.webContents.send(IpcChannels.IsMaximized, true)
    })

    this.win.on('unmaximize', () => {
      this.win && this.win.webContents.send(IpcChannels.IsMaximized, false)
    })

    this.win.on('enter-full-screen', () => {
      this.win && this.win.webContents.send(IpcChannels.FullscreenStateChange, true)
    })

    this.win.on('leave-full-screen', () => {
      this.win && this.win.webContents.send(IpcChannels.FullscreenStateChange, false)
    })

    // Save window position
    const saveBounds = () => {
      const bounds = this.win?.getBounds()
      if (bounds) {
        store.set('window', bounds)
      }
    }
    this.win.on('resized', saveBounds)
    this.win.on('moved', saveBounds)
  }

  handleAppEvents() {
    app.on('window-all-closed', () => {
      this.win = null
      if (lyricWin) lyricWin.win = null
      if (!isMac) app.quit()
    })

    app.on('second-instance', () => {
      if (!this.win) return
      // Focus on the main window if the user tried to open another
      if (this.win.isMinimized()) this.win.restore()
      this.win.focus()
    })

    app.on('activate', () => {
      const allWindows = BrowserWindow.getAllWindows()
      if (allWindows.length) {
        allWindows[0].focus()
      } else {
        this.createWindow()
      }
    })
  }
}

const main = new Main()
export default main
