# Lightstream WebRTC Client  

---

A frontend WebRTC wrapper for Lightstream Cloud.

## Documentation

---

This client uses the following tools:

- [Mediasoup](https://github.com/versatica/mediasoup/) v3 for WebRTC communications
- [XState](https://github.com/davidkpiano/xstate) for state management

### Root

`import * as webrtc from 'infiniscene-webrtc-client'`

_Core functions_

**startRoom(`settings: RoomSettings, id: string`)**  
**deleteRoom()**

_Helpers_

**watchDevices()**  
**ensureDevicePermissions()**  
**getDevicePermissions()**  
**getUserMedia()**

### Room

`const room = webrtc.startRoom()`

_Commands_

**room.Join()**  
**room.Leave()**  
**room.Connect()**  
**room.Disconnect()**  
**room.Close()**  
**room.SendVideo(`VideoDefinition`)**  
**room.SendAudio(`AudioDefinition`)**  
**room.SwitchVideo(`{ mediaId: string, newDefinition: VideoDefinition }`)**  
**room.SwitchAudio(`{ mediaId: string, newDefinition: AudioDefinition }`)**  
**room.PauseMedia(`{ mediaId: string }`)**  
**room.ResumeMedia(`{ mediaId: string }`)**  
**room.StopSendingMedia(`{ mediaId: string }`)**  
**room.ModifyMedia(`{ constraints: MediaTrackConstraints }`)**  
**room.UpdatePeer(`{ data: any }`)**  
**room.RestartIce()**

_Utility_

**room.watch(`MediaWatchOptions`, `(Media | null) => void`)**  
**room.useState(`(RoomState) => void`)**
**room.useMedia(`mediaId: string`, `(MediaState) => void`)**

_Properties_

**room.id**  
**room.peerId**  
**room.settings**  
**room.service**

[View type definitions](/src/index.ts)
