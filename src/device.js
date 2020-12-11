'use strict'

import State from 'ampersand-state'
import { extend, capitalize } from 'lodash/fp'

const DeviceModel = State.extend({
  resolutions: {
    qvga: { width: { ideal: 320 }, height: { ideal: 240 } },
    vga: { width: { ideal: 640 }, height: { ideal: 480 } },
    hd: { width: { ideal: 1280 }, height: { ideal: 720 } },
  },
  props: {
    id: 'string',
    kind: 'string',
    direction: 'string',
    deviceId: 'string',
    groupId: 'string',
    resolution: ['string', true, 'hd'],
    label: 'string',
    track: 'object',
    webrtc: 'state',
    isHighFidelity: ['boolean', true, false],
  },
  derived: {
    displayName: {
      deps: ['label', 'deviceId', 'type'],
      fn() {
        return this.label
          ? this.label.split(/\s\(.{4}:.{4}\)/)[0]
          : `Unidentified ${capitalize(this.type)}`
      },
    },
    type: {
      deps: ['kind'],
      fn() {
        if (this.kind === 'audioinput') {
          return 'microphone'
        } else if (this.kind === 'videoinput') {
          return 'webcam'
        } else if (this.kind === 'audiooutput') {
          return 'speakers'
        }
      },
    },
  },
  initialize() {},
  async getTrack() {
    // Attempt to reuse an active promise if available
    if (!this.gettingTrack) {
      if (this.kind === 'audioinput') {
        this.gettingTrack = this._getTrackMicrophone()
      } else if (this.kind === 'videoinput') {
        this.gettingTrack = this._getTrackWebcam()
      }
    }
    return this.gettingTrack.then((track) => {
      this.gettingTrack = null
      this.track = track
      return track
    })
  },
  async _getTrackWebcam() {
    const stream = await this.webrtc.getUserMedia({
      video: extend({ deviceId: { exact: this.deviceId } })(
        this.resolutions[this.resolution],
      ),
    })
    return stream.getVideoTracks()[0]
  },
  async _getTrackMicrophone() {
    let constraints = {
      deviceId: this.deviceId,
      sampleRate: { ideal: 48000 },
    }
    constraints = this.isHighFidelity
      ? {
          ...constraints,
          channelCount: 2,
          echoCancellation: false,
          autoGainControl: false,
          autoGainControl2: false,
          noiseSuppression: false,
          highpassFilter: false,
          typingNoiseDetection: false,
        }
      : {
          ...constraints,
          advanced: [
            { googEchoCancellation: true },
            { googExperimentalEchoCancellation: true },
            { autoGainControl: true },
            { noiseSuppression: true },
            { googHighpassFilter: true },
            { googAudioMirroring: true },
          ],
        }

    const stream = await this.webrtc.getUserMedia({
      audio: constraints,
    })
    if (this.isHighFidelity) {
      // Try to apply certain constraints again if they don't apply initially
      await stream.getAudioTracks().forEach((x) => {
        x.applyConstraints &&
          x.applyConstraints({
            channelCount: 2,
            sampleRate: { ideal: 48000 },
          })
      })
    }
    return stream.getAudioTracks()[0]
  },

  getIsVAC() {
    // An unreliable test to determine whether a device is a Virtual Audio input
    return /(V|v)irtual/.test(this.label)
  },
})

export default DeviceModel
