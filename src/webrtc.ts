import { interpret, Interpreter, State } from 'xstate'
import bowser from 'bowser'
import {
  Browser,
  Devices,
  Media,
  MediaMachineContext,
  MediaWatchOptions,
  Microphone,
  Room,
  RoomCommand,
  RoomMachineContext,
  Speakers,
  Webcam,
} from './index'
import { roomMachine } from './room'

export const getBrowserInfo = () => {
  const ua = navigator.userAgent
  const browser = bowser.getParser(ua)
  let flag

  if (browser.satisfies({ chrome: '>=0', chromium: '>=0' })) flag = 'chrome'
  else if (browser.satisfies({ firefox: '>=0' })) flag = 'firefox'
  else if (browser.satisfies({ safari: '>=0' })) flag = 'safari'
  else if (browser.satisfies({ opera: '>=0' })) flag = 'opera'
  else if (browser.satisfies({ 'microsoft edge': '>=0' })) flag = 'edge'
  else flag = 'unknown'

  return {
    flag,
    name: browser.getBrowserName(),
    version: browser.getBrowserVersion(),
  } as Browser
}

const numberToHex = (x: number) => x.toString(16)
const randomHexChar = () => numberToHex(Math.random() * 16)[0]
export const generateID = () => {
  const d = Math.round(Date.now() / 1000)
  return `${d}${Array(10).fill('').map(randomHexChar).join('')}`
}

const formatState = (state: State<any, any>) => ({
  ...state.context,
  state: state.toStrings().reverse()[0],
  matches: state.matches,
})

const useObservable = <T extends any>(
  observable: Interpreter<any, any, any>,
  cb: (
    state: T & {
      state: string
      matches: (state: string) => boolean
    },
  ) => void,
) => {
  // @ts-ignore
  const subscription = observable.subscribe({
    next: (x) => cb(formatState(x)),
    complete: () => {},
  })
  cb(formatState(observable.state))

  return () => {
    subscription.unsubscribe()
  }
}

type RoomConfig = {
  id?: RoomMachineContext['id']
  peerId?: RoomMachineContext['peerId']
  peerInfo?: RoomMachineContext['peerInfo']
  settings?: RoomMachineContext['settings']
  hostname?: string
  port?: number
}

export const startRoom = ({
  id,
  peerId,
  peerInfo = {},
  settings = {},
  hostname,
  port,
}: RoomConfig) => {
  if (id && rooms.get(id)) return rooms.get(id)
  id = id || generateID()
  peerId = peerId || generateID()

  // TODO: Pull from config
  hostname = hostname || window.location.hostname
  port = port || 3443
  const socketUrl = `wss://${hostname}:${port}/?room-id=${id}&peer-id=${peerId}`
  const onDiagnostics: RoomMachineContext['onDiagnostics'] = (notification) => {
    if (typeof API?.onDiagnostics === 'function') {
      API?.onDiagnostics(notification)
    }
  }

  const config = {
    id,
    peers: [],
    media: [],
    chat: [],
    protoo: null,
    sendTransport: null,
    recvTransport: null,
    mediasoupDevice: null,
    browser: getBrowserInfo(),
    socketUrl,
    onDiagnostics,
    peerInfo,
    peerId,
    settings: {
      produce: true,
      consume: true,
      ...settings,
    },
  } as RoomMachineContext

  const room = interpret(roomMachine.withContext(config)).start()

  const sendCommand = (command: RoomCommand) => {
    room.send({
      type: 'COMMAND',
      command,
    })
  }

  const mediaMatchesWatchOptions = (
    media: Media,
    { deviceId, kind, type, peerId }: MediaWatchOptions,
  ) => {
    if (kind !== media.kind) return false
    if (type !== 'any' && type !== media.type) return false
    if (deviceId !== 'any' && deviceId !== media.deviceId) return false
    if (peerId !== 'any' && peerId !== media.peerId) return false
    return true
  }

  type WatcherSettings = {
    options: MediaWatchOptions
    active?: Media
  }
  type MediaAvailability = {
    media: Media
    available: boolean
  }[]
  const watchers = new Map<(media?: Media) => void, WatcherSettings>()

  // Has side-effects
  const getActiveMediaForWatcher = (
    mediaList: MediaAvailability,
    settings: WatcherSettings,
  ) => {
    // See if the active media is still available
    if (settings.active) {
      const stillActive = mediaList.some(
        (x) => x.media.id === settings.active.id && x.available,
      )
      // Do nothing
      if (stillActive) return
    }
    // If it's not, try to find another one
    const nowActive = mediaList.find(
      (x) => x.available && mediaMatchesWatchOptions(x.media, settings.options),
    )
    // Set the new active media for reference on next change
    settings.active = nowActive?.media
    return nowActive?.media
  }

  const onMediaChange = () => {
    const mediaList = getMediaList()
    watchers.forEach((settings, cb) => {
      const nowActive = getActiveMediaForWatcher(mediaList, settings)

      // Only callback if we have a valid media for the watcher
      if (nowActive) {
        cb(nowActive)
      }
    })
  }

  const getMediaList = () =>
    room.state.context.media.map((m) => ({
      media: m.actor.state.context,
      available: m.actor.state.matches('active.live'),
    }))
  room.onTransition(() => {
    // PERF: This is unnecessarily frequent
    onMediaChange()
  })

  const API = {
    // Establish socket connection to the room on the server
    Connect: () => room.send({ type: 'CONNECT' }),
    // Prepare to send to and receive media from other peers
    Join: () => room.send('JOIN'),
    // Close transports and halt inbound/outbound media streams
    Leave: () => room.send('LEAVE'),
    // Close all communications with the server
    Disconnect: () => room.send('DISCONNECT'),
    // Close and discard the room entirely
    Close: () => deleteRoom(room.id),
    SendVideo: (payload) =>
      sendCommand({
        name: 'SendVideo',
        payload,
      }),
    SendAudio: (payload) =>
      sendCommand({
        name: 'SendAudio',
        payload,
      }),
    PauseMedia: (payload) =>
      sendCommand({
        name: 'PauseMedia',
        payload,
      }),
    ResumeMedia: (payload) =>
      sendCommand({
        name: 'ResumeMedia',
        payload,
      }),
    StopSendingMedia: (payload) =>
      sendCommand({
        name: 'StopSendingMedia',
        payload,
      }),
    SwitchAudio: (payload) =>
      sendCommand({
        name: 'SwitchAudio',
        payload,
      }),
    SwitchVideo: (payload) =>
      sendCommand({
        name: 'SwitchVideo',
        payload,
      }),
    ModifyMedia: (payload) =>
      sendCommand({
        name: 'ModifyMedia',
        payload,
      }),
    UpdatePeer: (payload) =>
      sendCommand({
        name: 'UpdatePeer',
        payload,
      }),
    RestartIce: () =>
      sendCommand({
        name: 'RestartIce',
      }),
    SendChatMessage: (payload) =>
      sendCommand({
        name: 'SendChatMessage',
        payload,
      }),
    getMedia: (mediaId) => {
      const media = room.state.context.media.find((x) => x.id === mediaId)
      if (!media) return null
      return formatState(media.actor.state)
    },
    useMedia: (mediaId, cb) => {
      const media = room.state.context.media.find((x) => x.id === mediaId)
      if (!media) return () => {}
      return useObservable<MediaMachineContext>(media.actor, cb)
    },
    getState: () => {
      return formatState(room.state)
    },
    useState: (cb) => {
      return useObservable<RoomMachineContext>(room, cb)
    },
    watch: (options, cb) => {
      const settings = {
        options: {
          type: 'any',
          deviceId: 'any',
          peerId: 'any',
          ...options,
        } as MediaWatchOptions,
      }
      watchers.set(cb, settings)
      cb(getActiveMediaForWatcher(getMediaList(), settings))

      return () => {
        watchers.delete(cb)
      }
    },
    onDiagnostics,
    sendCommand,
    id,
    peerId,
    settings,
    service: room,
  } as Room

  rooms.set(id, API)
  return API
}

export const deleteRoom = (id: string) => {
  const room = rooms.get(id)
  if (room) {
    room.service.send('DISCONNECT')
    rooms.delete(id)
  }
}

/**
 * Begin device helpers
 */

type DeviceCallback = (devices: Devices) => void
const deviceWatchers: Set<DeviceCallback> = new Set()

export const getDevicePermissions = async () => {
  // Get the available device information
  const devices = await navigator.mediaDevices.enumerateDevices()
  // Check each kind for a device ID to determine whether permission has been granted
  const firstWebcam = devices.find((x) => x.kind === 'videoinput')
  const firstMicrophone = devices.find((x) => x.kind === 'audioinput')
  return {
    video: Boolean(firstWebcam) && Boolean(firstWebcam.deviceId),
    audio: Boolean(firstMicrophone) && Boolean(firstMicrophone.deviceId),
  }
}

export const ensureDevicePermissions = async () => {
  const currentPermissions = await getDevicePermissions()
  if (currentPermissions.audio && currentPermissions.video)
    return currentPermissions

  try {
    const stream = await getUserMedia({
      video: !currentPermissions.video,
      audio: !currentPermissions.audio,
    })
    stream.getTracks().forEach((track) => {
      track.stop()
    })
    return getDevicePermissions()
  } catch (e) {
    console.warn(e)
    return currentPermissions
  }
}

export const watchDevices = (cb: DeviceCallback) => {
  if (deviceWatchers.size === 0) {
    navigator.mediaDevices.addEventListener('devicechange', reportDevices)
  }
  deviceWatchers.add(cb)
  reportDevices().catch(() => {})

  return () => {
    deviceWatchers.delete(cb)
    if (deviceWatchers.size === 0) {
      navigator.mediaDevices.removeEventListener('devicechange', reportDevices)
    }
  }
}

export const getUserMedia: MediaDevices['getUserMedia'] = async (...args) => {
  const media = await navigator.mediaDevices.getUserMedia(...args)
  reportDevices()
  return media
}

const reportDevices = async () => {
  const permissions = await ensureDevicePermissions()
  const devices = await navigator.mediaDevices.enumerateDevices()
  // TODO: Format device names
  const webcams = permissions.video
    ? (devices.filter((x) => x.kind === 'videoinput') as Webcam[])
    : []
  const microphones = permissions.audio
    ? (devices.filter((x) => x.kind === 'audioinput') as Microphone[])
    : []
  const speakers = permissions.audio
    ? (devices.filter((x) => x.kind === 'audiooutput') as Speakers[])
    : []
  deviceWatchers.forEach((cb) =>
    cb({
      webcams,
      microphones,
      speakers,
    }),
  )
}
deviceWatchers.forEach((x) => {})

export const rooms = new Map<string, Room>()
