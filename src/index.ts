import { Peer as _ProtooPeer } from 'protoo-client'
import { types } from 'mediasoup-client'
import { Interpreter } from 'xstate'

export type Peer = {
  id: string
  device: Browser
  info?: any
}

export type Browser = {
  flag: string
  name: string
  version: string
}

export type Video = {
  id: string
  kind: 'video'
  type: 'webcam' | 'screen' | 'unknown'
  label?: string
  track?: MediaStreamTrack
  consumer?: Consumer
  producer?: Producer
  deviceId?: string
  peerId?: string
}

export type Audio = {
  id: string
  kind: 'audio'
  type: 'microphone' | 'sound' | 'unknown'
  label?: string
  track?: MediaStreamTrack
  consumer?: Consumer
  producer?: Producer
  deviceId?: string
  peerId?: string
}

export type MediaActor = Interpreter<
  MediaMachineContext,
  MediaMachineSchema,
  MediaMachineEvent
>
export type Media = (Video | Audio) & {
  actor?: MediaActor
}

export type Device = types.Device
export type Consumer = types.Consumer
export type Producer = types.Producer
export type Transport = types.Transport
export type ProtooPeer = _ProtooPeer

export interface RoomMachineSchema {
  states: {
    waiting: {}
    active: {
      states: {
        connecting: {}
        reconnecting: {}
        connected: {
          states: {
            waiting: {}
            joining: {}
            joined: {}
            leaving: {}
            left: {}
          }
        }
      }
    }
  }
}

export type VideoDefinition = {
  type: Video['type']
  deviceId?: string
  label?: string
  resolution?: 'qvga' | 'vga' | 'hd'
  constraints?: Partial<MediaTrackConstraints>
  track?: MediaStreamTrack
}

export type AudioDefinition = {
  type: Audio['type']
  deviceId?: string
  label?: string
  constraints?: Partial<MediaTrackConstraints>
  track?: MediaStreamTrack
}

export type RoomCommand =
  | { name: 'RestartIce' }
  | { name: 'UpdatePeer'; payload: { data: any } }
  | {
      name: 'SendVideo'
      payload: VideoDefinition
    }
  | {
      name: 'SendAudio'
      payload: AudioDefinition
    }
  | {
      name: 'SwitchVideo'
      payload: {
        mediaId: string
        newDefinition: Omit<VideoDefinition, 'type'>
      }
    }
  | {
      name: 'SwitchAudio'
      payload: {
        mediaId: string
        newDefinition: Omit<AudioDefinition, 'type'>
      }
    }
  | {
      name: 'PauseMedia'
      payload: { mediaId: string }
    }
  | {
      name: 'ResumeMedia'
      payload: { mediaId: string }
    }
  | {
      name: 'ModifyMedia'
      payload: { constraints: MediaTrackConstraints }
    }
  | {
      name: 'StopSendingMedia'
      payload: { mediaId: string }
    }

export type RoomRequestEvent = {
  type: 'REQUEST'
  context?: RoomMachineContext
  request: IncomingRequest
  accept: () => void
  reject: (reason?: string) => void
}

// TODO: Type all request names and data
type IncomingRequest = { name: string; data: any }

export type RoomNotificationEvent = {
  type: 'NOTIFICATION'
  notification: Notification
  context?: RoomMachineContext
}

// TODO: Type all notification names and data
export type Notification = { name: string; data: any }

export type RoomCommandEvent = {
  type: 'COMMAND'
  command: RoomCommand
  context?: RoomMachineContext
}

export type MediaAddedEvent =
  | { type: 'REMOTE_MEDIA_ADDED'; media: Media }
  | { type: 'LOCAL_MEDIA_ADDED'; media: Media }
export type MediaRemovedEvent = {
  type: 'MEDIA.CLOSED'
  mediaId: string
}

export type RoomMachineEvent =
  | RoomCommandEvent
  | RoomRequestEvent
  | RoomNotificationEvent
  | { type: 'JOIN' }
  | { type: 'CONNECT' }
  | { type: 'DISCONNECT' }
  | { type: 'CLOSE' }
  | { type: 'LEAVE' }
  | {
      type: 'SOCKET.CONNECTED'
      protoo: ProtooPeer
      mediasoupDevice: Device
    }
  | { type: 'SOCKET.FAILED' }
  | { type: 'SOCKET.DISCONNECTED' }
  | { type: 'SOCKET.CLOSED' }
  | { type: 'MEDIA.CLOSED'; mediaId: string }
  | { type: 'PEER_JOINED'; peer: Peer }
  | { type: 'PEER_LEFT'; peerId: string }
  | {
      type: 'PEER_UPDATED'
      peerId: string
      info: Peer['info']
    }
  | MediaRemovedEvent
  | MediaAddedEvent

export type RoomSettings = {
  produce?: boolean
  consume?: boolean
  forceTcp?: boolean
  forceH264?: boolean
  forceVP9?: boolean
  useSimulcast?: boolean
}

export interface RoomMachineContext {
  id: string
  socketUrl: string
  peerId: string
  peerInfo: any
  peers: Peer[]
  media: Media[]
  protoo: ProtooPeer
  browser: Browser
  sendTransport: Transport
  recvTransport: Transport
  mediasoupDevice: Device
  settings: RoomSettings
  onDiagnostics?: (notification: Notification) => void
}

export type RoomService = Interpreter<
  RoomMachineContext,
  RoomMachineSchema,
  RoomMachineEvent,
  { value: any; context: RoomMachineContext }
>

// NOTE: For now, Media are always live (no local tracks)
export type MediaMachineSchema = {
  states: {
    active: {
      states: {
        _: {}
        live: {
          states: {
            healthy: {}
            unhealthy: {}
          }
        }
        paused: {}
      }
    }
    switching: {}
    stopped: {}
  }
}

export type MediaMachineEvent =
  | { type: 'SWITCH'; track: MediaStreamTrack }
  | { type: 'SWITCH_COMPLETE' }
  | { type: 'SWITCH_FAILED' }
  | { type: 'PAUSED' } // Consumer only
  | { type: 'RESUMED' } // Consumer only
  | { type: 'CLOSED' } // consumer/producer.
  | { type: 'TRACK.METADATA_FAILURE' } // track.muted=true (track.onmuted)
  | { type: 'TRACK.METADATA_RESOLVED' } // track.muted=false (track.onunmuted)
  | { type: 'TRACK.ENDED' } // (track.onended)

export type MediaMachineContext = Media

type CommandValue<T extends RoomCommand['name']> = Extract<
  RoomCommand,
  { name: T }
>

type Payload<
  T extends RoomCommand['name']
> = CommandValue<T> extends {
  payload: unknown
}
  ? CommandValue<T>['payload']
  : never

type CommandAPI = {
  [name in RoomCommand['name']]: (
    payload: Payload<name>,
  ) => void
}

type Disposable = () => void
export type MediaWatchOptions = {
  kind: Media['kind']
  type?: Media['type'] | 'any'
  peerId?: string | 'any'
  deviceId?: string | 'any'
}

export type MediaState = MediaMachineContext & {
  state: string
  matches: (state: string) => boolean
}
export type RoomState = RoomMachineContext & {
  state: string
  matches: (state: string) => boolean
}
export type Room = {
  id: string
  peerId: string
  service: RoomService
  Join: () => void
  Leave: () => void
  Connect: () => void
  Disconnect: () => void
  Close: () => void
  onDiagnostics: RoomMachineContext['onDiagnostics']
  settings: RoomSettings
  getMedia: (mediaId: string) => MediaState
  useMedia: (
    mediaId: string,
    cb: (media: MediaState) => void,
  ) => Disposable
  getState: () => RoomState
  useState: (cb: (room: RoomState) => void) => Disposable
  watch: (
    options: MediaWatchOptions,
    cb: (media: Media) => void,
  ) => Disposable
} & CommandAPI

export type Webcam = MediaDeviceInfo & {
  kind: 'videoinput'
}
export type Microphone = MediaDeviceInfo & {
  kind: 'audioinput'
}
export type Speakers = MediaDeviceInfo & {
  kind: 'audiooutput'
}
export type Devices = {
  webcams: Webcam[]
  microphones: Microphone[]
  speakers: Speakers[]
}
