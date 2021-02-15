import { Browser, Devices, Room, RoomMachineContext } from './src/index'

export declare const getBrowserInfo: () => Browser
export declare const generateID: () => string
declare type RoomConfig = {
  id?: RoomMachineContext['id']
  peerId?: RoomMachineContext['peerId']
  peerInfo?: RoomMachineContext['peerInfo']
  settings?: RoomMachineContext['settings']
}
export declare const startRoom: ({
  id,
  peerId,
  peerInfo,
  settings,
}: RoomConfig) => Room
export declare const deleteRoom: (id: string) => void
declare type DeviceCallback = (devices: Devices) => void
export declare const getDevicePermissions: () => Promise<{
  video: boolean
  audio: boolean
}>
export declare const ensureDevicePermissions: () => Promise<{
  video: boolean
  audio: boolean
}>
export declare const watchDevices: (cb: DeviceCallback) => () => void
export declare const getUserMedia: MediaDevices['getUserMedia']
export declare const rooms: Map<string, Room>
export {}

export * as LS from './src/index'
export as namespace LS
