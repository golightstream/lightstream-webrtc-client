'use strict'

import State from 'ampersand-state'
import Collection from 'ampersand-rest-collection'
import { RoomCollection, Room } from './room'
import DeviceModel from './device'
import * as mediasoupClient from 'mediasoup-client'
import Observable from './_observable'
import flow from 'lodash/flow'
import debug from 'debug'
import { assign, map, filter, extend, groupBy, omit } from 'lodash/fp'

const GUM_DEFAULTS = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 } },
}

const log = debug('Lightstream:WebRTC')
const warn = debug('Lightstream:WebRTC (Warn)')

const getTurnServers = async device => {
  return [{ urls: 'stun:stun.l.google.com:19302' }]
}

const WebRTC = State.extend(Observable).extend({
  props: {
    id: 'string',
    defaultPeerId: 'any',
    extensionUrl: 'string',
    turnServers: 'array',
    devicesLoaded: ['boolean', true, false],
    defaultIsHost: ['boolean', true, false],
    isListeningForDevices: ['boolean', true, false],
    device: ['object', true, () => ({})],
    audioCtx: 'object',
    permissionsAccepted: ['boolean', true, false],
    userWebcamId: ['string', true, ''], // The deviceId intended to be shared with other greenroom guests
    userMicrophoneId: ['string', true, ''], // The deviceId intended to be shared with other greenroom guests
  },
  collections: {
    rooms: RoomCollection,
    webcams: Collection.extend({ model: DeviceModel }),
    microphones: Collection.extend({ model: DeviceModel }),
    speakers: Collection.extend({ model: DeviceModel }),
  },
  initialize() {
    this.audioCtx = new (window.AudioContext ||
      window.webkitAudioContext ||
      Object)()
  },
  async prepare() {
    if (this.prepared) return
    this.device = mediasoupClient.getDeviceInfo()
    this.turnServers = await getTurnServers(this.device)
    this.updateDevices()
    return (this.prepared = true)
  },
  ensureRoom(id, settings = {}) {
    log('Getting webrtc room...', id)
    this.prepare()
    let room = this.rooms.get(id)
    if (!room) {
      room = new Room(
        assign(
          {
            id,
            manager: this,
            send: true,
            recv: true,
            peerId: this.defaultPeerId,
            isHost: this.defaultIsHost,
            turnServers: this.turnServers,
            userWebcamId: this.userWebcamId,
            userMicrophoneId: this.userMicrophoneId,
            accept: {
              // Place no restrictions on media by default
              deviceId: null,
              peerId: null,
              type: null,
            },
          },
          settings,
        ),
      )
      this.rooms.add(room)
    }
    return room
  },
  setUserWebcam(id) {
    this.userWebcamId = id
    this.rooms.forEach(x => (x.userWebcamId = id))
  },
  setUserMicrophone(id) {
    this.userMicrophoneId = id
    this.rooms.forEach(x => (x.userMicrophoneId = id))
  },

  // UserMedia helpers
  getUserMedia(constraints, requestPermission = false) {
    log('getUserMedia()', { constraints })
    return new Promise(async (resolve, reject) => {
      try {
        if (!requestPermission) {
          await this.waitFor('permissionsAccepted')
        }

        // Occasionally Firefox does not resolve or reject, so we reject on timeout
        window.setTimeout(reject, 5000)

        return resolve(navigator.mediaDevices.getUserMedia(constraints))
      } catch (e) {
        reject(e)
      }
    })
  },
  async updateDevices() {
    if (this.updatingDevices) return
    this.updatingDevices = true

    log('updateDevices()', ...arguments)

    if (!this.isListeningForDevices) {
      this.isListeningForDevices = true
      // Begin listening for available devices
      navigator.mediaDevices.addEventListener('devicechange', () => {
        this.updateDevices()
      })
    }

    // Once we get permissions, we will update devices again to extract their labels
    const [permissions, tracks = []] = await this.ensurePermissionState()
    if (!permissions) return permissions

    const getWebcamDirection = x =>
      /(back|rear)/i.test(x.label) ? 'back' : 'front'
    const extendWebcamDirection = x =>
      x.kind === 'videoinput'
        ? extend({ direction: getWebcamDirection(x) })(x)
        : x
    const extendDetails = x => extend({ id: x.deviceId, webrtc: this })(x)
    const deviceList = await navigator.mediaDevices.enumerateDevices()
    const devices = flow(
      filter(x => x.deviceId),
      map(extendWebcamDirection),
      map(extendDetails),
      map(x => (!x.label ? omit(['label'], x) : x)),
      groupBy('kind'),
    )(deviceList)

    this.microphones.set(devices.audioinput)
    this.speakers.set(devices.audiooutput)
    this.webcams.set(devices.videoinput)

    const hasValidUserWebcam =
      this.userWebcamId && this.webcams.get(this.userWebcamId)
    if (!hasValidUserWebcam && this.webcams.models[0]) {
      this.setUserWebcam(this.webcams.models[0].id)
    }
    const hasValidUserMicrophone =
      this.userMicrophoneId && this.microphones.get(this.userMicrophoneId)
    if (!hasValidUserMicrophone && this.microphones.models[0]) {
      this.setUserMicrophone(this.microphones.models[0].id)
    }

    this.devicesLoaded = true

    const activeTracks = [
      ...this.microphones.models,
      ...this.webcams.models,
    ].map(x => x.track)

    // Stop each track unless it's in use
    //  An arbitrary timeout allows views to claim ownership of the track if needed,
    //  otherwise browsers like Firefox will request permissions again.
    window.setTimeout(() => {
      tracks.filter(x => !activeTracks.includes(x)).forEach(x => x.stop())
    }, 3000)

    this.updatingDevices = false
    this.permissionsAccepted = permissions
    return true
  },
  getModelForMedia(media) {
    let model
    ;['webcams', 'microphones', 'speakers'].find(mediaCollectionKey => {
      model = this[mediaCollectionKey].find(
        ({ track }) => track && track === media.track,
      )

      // Return this to prevent unnecessary iteration.
      return model
    })

    return model
  },
  getDevicesByType(type) {
    if (type === 'webcam') return this.webcams.models
    if (type === 'microphone') return this.microphones.models
    if (type === 'speaker') return this.speakers.models
    return []
  },
  getDeviceByIdAndType(deviceId, type) {
    const devices = this.getDevicesByType(type)
    return devices.find(x => !deviceId || x.deviceId === deviceId)
  },
  async ensurePermissionState() {
    // Returns a tuple of [boolean<accepted>, MediaStreamTrack[]]
    const actionlessResult = [true, []]
    if (this.permissionsAccepted) return actionlessResult
    const [firstWebcam, firstMicrophone] = [
      this.webcams.first(),
      this.microphones.first(),
    ]
    let permissionsNeeded = {}
    if (!firstWebcam || !firstWebcam.label)
      permissionsNeeded.video = GUM_DEFAULTS.video
    if (!firstMicrophone || !firstMicrophone.label)
      permissionsNeeded.audio = true
    if (!permissionsNeeded.audio && !permissionsNeeded.video)
      return actionlessResult
    try {
      const stream = await this.getUserMedia(permissionsNeeded, true)
      stream.getTracks().forEach(track => {
        delete permissionsNeeded[track.kind]
      })
      return [Object.keys(permissionsNeeded).length === 0, stream.getTracks()]
    } catch (err) {
      return [
        !(
          err.name === 'PermissionDeniedError' || err.name === 'NotAllowedError'
        ),
        [],
      ]
    }
  },

  async openBrowserWindowSelection(selectionOptions = {}) {
    const { audio = true, screen = true } = selectionOptions
    const browser = this.device.flag

    let constraints = {
      audio: audio && {
        echoCancellation: false,
        autoGainControl: false,
        googAutoGainControl: false,
        noiseSuppression: false,
        googNoiseSuppression: false,
        highpassFilter: false,
        googHighpassFilter: false,
        typingNoiseDetection: false,
        googTypingNoiseDetection: false,
        channelCount: 2,
      },
    }
    let streamId
    let stream

    // Firefox can't handle audio yet - needs getUserMedia (as of 03/05/2020)
    if (
      navigator.mediaDevices.getDisplayMedia &&
      (browser === 'chrome' || browser === 'edge' || browser === 'safari')
    ) {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: screen,
        ...constraints,
      })
    } else if (browser === 'firefox') {
      constraints = { video: { mediaSource: 'screen' }, audio: false }
      stream = await this.getUserMedia(constraints)
    } else {
      return false
    }

    if (!stream) {
      const err = new Error(
        'getUserMedia did not return a stream under the constraints provided',
      )
      err.name = 'EmptyResponse'
      throw err
    }

    const audioTrack = stream.getAudioTracks()[0]
    const videoTrack = stream.getVideoTracks()[0]
    const result = {}

    if (audioTrack) {
      result.audio = {
        deviceId: 'browser',
        track: audioTrack,
      }
    }
    if (videoTrack) {
      if (!screen) {
        videoTrack.stop()
      } else {
        const screenType =
          videoTrack.label.substr(0, videoTrack.label.indexOf(':')) || 'Screen'
        result.video = {
          deviceId: streamId || videoTrack.label,
          track: videoTrack,
          screenType,
        }
      }
    }
    return result
  },
})

export default new WebRTC()
