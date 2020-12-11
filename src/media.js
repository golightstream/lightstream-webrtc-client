'use strict'

import State from 'ampersand-state'
import Collection from 'ampersand-rest-collection'
import Observable from './_observable'
import debug from 'debug'
import { pick } from 'ramda'

const log = debug('Lightstream:WebRTC:Media')
const warn = debug('Lightstream:WebRTC:Media (Warn)')

// Force mediasoup to use the same track
MediaStreamTrack.prototype.clone = null

/**
  A Media is an interface for an active MediaStreamTrack.
  This track may come from a local getUserMedia(), or a remote peer's feed.
  Media.type = 'screen' | 'audio' | 'webcam' | 'microphone' | 'audioFeed' | 'videoFeed'
*/
const STATE = {
  preparing: 'preparing',
  local: 'local',
  activating: 'activating',
  active: 'active',
  paused: 'paused',
  inactive: 'inactive',
}
const Media = State.extend(Observable).extend({
  props: {
    id: 'any',
    state: 'string',
    peerId: 'any',
    type: 'string',
    codec: 'string',
    track: 'object', // MediaStreamTrack
    profile: 'string',
    deviceId: 'any',
    displayName: 'string',
    remoteDisplayName: 'string',
    consumer: 'object',
    producer: 'object',
    manager: 'state',
    isCalculatingAudioLevels: ['boolean', true, false],
    isRemote: ['boolean', true, false],
    locallyPaused: ['boolean', true, false],
    remotelyPaused: ['boolean', true, false],
    simulcast: ['boolean', true, true],
    isMuted: ['boolean', true, false],
    level: ['number', true, 0.8],
    dependants: ['object', true, () => new Set()],
    audioDependants: ['object', true, () => new Set()],
    isHighFidelity: ['boolean', true, false],
  },
  initialize(options = {}) {
    this.track = this.track instanceof MediaStreamTrack ? this.track : null
    this.state = STATE.preparing
    this.room = options.room
    this.isRemote = Boolean(this.consumer)
    const mediasoupRoom = this.room.mediasoupRoom
    this.triggerUpdate = () =>
      this.room.trigger(
        'MediaUpdate',
        pick(['type', 'peerId', 'deviceId'], this),
      )
    this.createProducer = mediasoupRoom.createProducer.bind(mediasoupRoom)
    this.audioLevel = 0 // Seed this continuous value with an initial state

    if (this.producer) {
      this.logEvent('ProducerMediaAdded')
    } else if (this.consumer) {
      this.logEvent('ConsumerMediaAdded')
    }

    // Initialize Web Audio API hooks for audioAnalyser
    if (
      this.type === 'microphone' ||
      this.type === 'audio' ||
      this.type === 'audioFeed'
    ) {
      this.audioAnalyser = this.manager.audioCtx.createAnalyser()

      // Wait for user interaction
      if (this.manager.audioCtx.state === 'suspended') {
        document.addEventListener(
          'click',
          () => {
            this.manager.audioCtx.resume()
          },
          { once: true },
        )
      }
    }

    if (!this.isRemote) {
      // Listen for changes to device collection and close if it's no longer available
      const collection = this.type === 'webcam' ? 'webcams' : 'microphones'
      this.listenTo(this.manager[collection], 'remove reset', () => {
        const device = this.manager.getDeviceByIdAndType(
          this.deviceId,
          this.type,
        )
        if (!device) {
          return this.close()
        }
      })
    }

    this.listenToAndRun(this.room, 'change:statsEnabled', () => {
      if (this.room.statsEnabled) {
        this.enableStats(1000 * 4)
      } else {
        this.disableStats()
      }
    })

    this.on('change:state', async () => {
      log('Media state: ' + this.state + '...', this.id)
      if (this.producer) {
        this.logEvent('ProducerMediaStateChanged:' + this.state)
      } else if (this.consumer) {
        this.logEvent('ConsumerMediaStateChanged:' + this.state)
      }
    })
    this.on('change:track', () => {
      if (this.track) {
        this.activate()
      }
      this.triggerUpdate()
    })
  },
  useAudioLevels(dependantId, srcObject) {
    try {
      log('useAudioLevels()', { dependantId, srcObject })
      if (!dependantId)
        throw new Error(
          'Cannot call useAudioLevels() without specifying a dependant ID',
        )
      this.audioDependants.add(dependantId)

      const isCalculatingAudioLevels = this.isCalculatingAudioLevels

      if (srcObject) this.updateSourceForAudioLevels(srcObject)
      if (isCalculatingAudioLevels) return

      if (!srcObject) {
        srcObject = this.track ? new MediaStream([this.track]) : null
        this.updateSourceForAudioLevels(srcObject)
      }
    } catch (e) {
      warn('useAudioLevels() failed', e)
    }
  },
  stopUsingAudioLevels(dependantId) {
    try {
      log('stopUsingAudioLevels()', { dependantId })
      if (!dependantId)
        throw new Error(
          'Cannot call stopUsingAudioLevels() without specifying a dependant ID',
        )
      this.audioDependants.delete(dependantId)
      if (this.audioDependants.size === 0) {
        this.closeAudioSource()
      }
    } catch (e) {
      warn('stopUsingAudioLevels() failed', e)
    }
  },
  closeAudioSource() {
    try {
      if (this.isCalculatingAudioLevels) {
        this.audioSource && this.audioSource.disconnect(this.processor)
        this.processor &&
          this.processor.disconnect(this.manager.audioCtx.destination)
      }
    } catch (e) {
      warn('closeAudioSource() failed', e)
    } finally {
      this.isCalculatingAudioLevels = false
    }
  },
  updateSourceForAudioLevels(srcObject) {
    try {
      log('updateSourceForAudioLevels()', { srcObject })
      this.closeAudioSource()
      this.isCalculatingAudioLevels = true

      if (!srcObject) {
        return (this.audioLevel = 0)
      }

      // Create a simple pipeline required to analyze the MediaStreamSource
      this.audioSource = this.manager.audioCtx.createMediaStreamSource(
        srcObject,
      )
      this.processor = this.manager.audioCtx.createScriptProcessor(512)
      this.audioSource.connect(this.processor)
      this.processor.connect(this.manager.audioCtx.destination)

      // This is deprecated - consider replacing with AudioWorklet (not well documented as of 2/7/2019)
      // https://hoch.io/assets/publications/icmc-2018-choi-audioworklet.pdf
      this.processor.onaudioprocess = this._calculateAudioLevel.bind(this)
    } catch (e) {
      warn('updateSourceForAudioLevels() failed', e)
    }
  },
  _calculateAudioLevel(event) {
    if (this.isMuted || this.level === 0) {
      return (this.audioLevel = 0)
    }

    const buf = event.inputBuffer.getChannelData(0)
    const bufLength = buf.length
    let sum = 0

    // Do a root-mean-square on the samples: sum up the squares...
    let x
    for (let i = 0; i < bufLength; i++) {
      x = buf[i]
      sum += x * x
    }

    // ... then take the square root of the sum.
    const rms = Math.sqrt(sum / bufLength)

    // Now smooth this out with the averaging factor applied
    // to the previous sample - take the max here because we
    // want "fast attack, slow release."
    // Note: The factor of 2 is only to make audio changes more noticeable
    this.audioLevel =
      Math.max(rms, (this.audioLevel / (this.level * 2)) * 0.97) *
      (this.level * 2)
  },
  async activate() {
    const isAlreadyActive =
      this.state === STATE.activating ||
      this.state === STATE.active ||
      this.state === STATE.paused
    const isRoomConnected = this.room.state === 'connected'
    const hasDependants = this.dependants.size > 0

    if (this.consumer && this.state === STATE.paused) {
      return this.unpause()
    }

    // We won't send the track unless a local source depends on it with `useTrack()`
    if (isAlreadyActive || !isRoomConnected || !hasDependants) {
      log('Ignoring call to activate media', {
        isAlreadyActive,
        isRoomConnected,
        hasDependants,
      })
      return this
    }

    this.state = STATE.activating

    try {
      if (this.consumer) {
        return await this.receive()
      } else {
        return await this.send()
      }
    } catch (e) {
      warn(e)
      return this.close()
    }
  },
  pause() {
    // Sets the track "enabled" property to false and stops sending/receiving RTP
    if (this.producer) {
      this.logEvent('PauseProducerMedia')
      this.producer.pause()
    }
    if (this.consumer) {
      this.logEvent('PauseConsumerMedia')
      this.consumer.pause()
    }
  },
  unpause() {
    // Sets the track "enabled" property to true and resumes sending/receiving RTP
    if (this.producer) {
      this.logEvent('ResumeProducerMedia')
      this.producer.resume()
    }
    if (this.consumer) {
      this.logEvent('ResumeConsumerMedia')
      this.consumer.resume()
    }
  },
  async send() {
    // If we don't have a track, start a new one
    if (!this.track || this.track.readyState === 'ended')
      await this.initializeLocalTrack(this.deviceId)

    // If we still don't have a track, we were unable to pull one from a valid device
    // We will remain "activating" until a valid track is received
    if (!this.track) {
      this.state = STATE.inactive
      return this
    }

    const device = this.manager.getDeviceByIdAndType(this.deviceId, this.type)

    // Initiate the transport and begin sending the track to our SFU
    this.producer = this.createProducer(
      this.track,
      { simulcast: this.simulcast },
      {
        // peers receive as consumer appData:
        type: this.type,
        peerId: this.peerId,
        deviceId: this.deviceId,
        deviceLabel: device && device.label,
        isHighFidelity: device && device.isHighFidelity,
      },
    )

    // Update the track to ensure bindings are in place
    this.updateTrack(this.producer.track)

    // Send it out
    await this.producer.send(this.room._sendTransport)

    if (this.locallyPaused) {
      this.producer.pause()
    }

    this.set({ codec: this.producer.rtpParameters.codecs[0].name })

    // Producer event handlers
    this.producer.on('stats', ([inboundStats, outboundStats]) => {
      if (!inboundStats) return
    })
    this.producer.on('close', () => {
      log('Producer "close" event', this.getAttributes({ props: true }))
      this.close()
    })
    this.producer.on('pause', (originator) => {
      log('Producer "pause" event', {
        model: this.getAttributes({ props: true }),
        originator,
      })
      if (originator === 'local') {
        this.locallyPaused = true
      } else {
        this.remotelyPaused = true
      }
      this.state = STATE.paused
      this.triggerUpdate()
    })
    this.producer.on('resume', (originator) => {
      log('Producer "resume" event', {
        model: this.getAttributes({ props: true }),
        originator,
      })
      if (originator === 'local') {
        this.locallyPaused = false
      } else {
        this.remotelyPaused = false
      }
      this.state = STATE.active
      this.triggerUpdate()
    })

    this.state =
      this.locallyPaused || this.remotelyPaused ? STATE.paused : STATE.active

    return this
  },
  async receive() {
    // If the consumer is paused then we must simply unpause to activate the feed
    if (this.locallyPaused) {
      return this.unpause()
    }

    // Initiate the transport and receive the live track
    const track = await this.consumer.receive(this.room._recvTransport)

    // Consumer event handlers
    this.consumer.on('close', (originator) => {
      log('Consumer "close" event', {
        model: this.getAttributes({ props: true }),
        originator,
      })
      this.close()
    })
    this.consumer.on('pause', (originator) => {
      log('Consumer "pause" event', {
        model: this.getAttributes({ props: true }),
        originator,
      })
      if (originator === 'local') {
        this.locallyPaused = true
        this.state = STATE.paused
      } else {
        // If the feed is remotely paused, discard the track entirely
        this.remotelyPaused = true
        this.updateTrack(null)
      }
    })
    this.consumer.on('resume', (originator) => {
      log('Consumer "resume" event', {
        model: this.getAttributes({ props: true }),
        originator,
      })
      if (originator === 'local') {
        this.locallyPaused = false
      } else {
        this.remotelyPaused = false
        this.updateTrack(this.consumer.track)
      }
      this.state = STATE.active
      this.triggerUpdate()
    })
    this.consumer.on('effectiveprofilechange', (profile) => {
      log('Consumer "effectiveprofilechange" event', {
        model: this.getAttributes({ props: true }),
        profile,
      })
      this.profile = profile
    })

    this.set({
      locallyPaused: this.consumer.locallyPaused,
      remotelyPaused: this.consumer.remotelyPaused,
      codec: this.consumer.rtpParameters.codecs[0].name,
    })

    this.state =
      this.locallyPaused || this.remotelyPaused ? STATE.paused : STATE.active

    await this.updateTrack(track)
    return this
  },
  async initializeLocalTrack(deviceId) {
    log('initializeLocalTrack', { model: this.getAttributes({ props: true }) })
    return (
      this._initializingLocalTrack ||
      (this._initializingLocalTrack = async () => {
        // If we have a consumer, there is no concept of a local track
        if (this.consumer) return this.track
        if (this.dependants.size === 0) return null

        // Update the user's local device list so we can query for the deviceId
        await this.manager.updateDevices().catch(warn)

        // This accepts a null deviceId, so if we didn't have one - we will come out with the first valid
        const devices = this.manager.getDevicesByType(this.type)
        const device = !deviceId
          ? devices[0]
          : devices.find((x) => x.id === deviceId)

        if (!device) {
          warn('Tried to initialize track, but could not find device')
          return (this.state = STATE.inactive)
        }

        this.isHighFidelity = device.isHighFidelity

        // Stop the previous track before trying to get a new one, otherwise it may return the current track
        if (this.track) this.track.stop()

        const previousDevice = devices.find((x) => x.id === this.deviceId)
        if (previousDevice)
          this.stopListening(previousDevice, 'change:isHighFidelity')

        // Update state to reflect the new device
        this.displayName = device.displayName
        this.deviceId = device.id
        const newTrack = await device.getTrack()

        this.listenTo(device, 'change:isHighFidelity', async () => {
          if (device.id === this.deviceId) {
            this.isHighFidelity = device.isHighFidelity
            // Update the track with latest model state
            this.updateTrack(await device.getTrack())
          }
        })

        if (!newTrack) {
          // We couldn't get a new track, so go inactive until further instruction is received
          return (this.state = STATE.inactive)
        }

        // Update state to reflect our new local track
        if (
          this.state !== STATE.activating &&
          this.state !== STATE.active &&
          this.state !== STATE.paused
        ) {
          this.state = STATE.local
        }

        await this.updateTrack(newTrack)
        return this.track
      })()
        .catch((e) => {
          warn('Error occurred while initializing local track:', e)
          this.logEvent('InitializeTrackFailed')
          this.track = null
          return null
        })
        .then((result) => {
          this._initializingLocalTrack = null
          return result
        })
    )
  },
  async changeDevice(deviceId) {
    if (deviceId === this.deviceId) return

    // Initialize the track using the new device
    await this.initializeLocalTrack(deviceId)

    this.logEvent('ChangeProducerDevice')

    return this.deviceId
  },
  async updateTrack(track) {
    // Close the previous track silently
    const previousTrack = this.track

    if (track) {
      track.onended = () => {
        if (this.producer) {
          this.logEvent('ProducerTrackEndedPrematurely')
        }
        warn('Track ended unexpectedly. Closing media...', {
          media: this.getAttributes({ props: true }),
        })
        this.clearTrack()
        this.close()
      }
    }

    if (track === this.track) return this

    // Return early if we are ingesting the track
    if (this.consumer) {
      // Set the new track locally
      this.track = track
      return this
    }

    if (previousTrack) {
      previousTrack.onended = () => {}
      previousTrack.stop()
    }

    // Set the new track locally
    this.track = track

    if (this.state === STATE.active) {
      // Update the live RTP feed
      this.state = STATE.activating
      await this.producer.replaceTrack(track)
      this.state = STATE.active
    }

    if (this.state === STATE.paused) {
      // Update the producer track, but remain paused (not sending)
      await this.producer.replaceTrack(track)
    }

    return this
  },
  async useTrack(dependantId) {
    // In order to access a track, a dependant should register with this function
    // This is to ensure that a track is never left active unless it is in use
    if (!dependantId)
      throw new Error(
        'Cannot call useTrack() without specifying a dependant ID',
      )
    log('useTrack()', { dependantId }, this.kind, this.label)
    this.dependants.add(dependantId)

    // If we weren't supplied a track, try to extract one based on the deviceId
    if (!this.track) {
      await this.initializeLocalTrack(this.deviceId)
    }

    // Begin sending or receiving the track if we are live
    this.activate()

    return this.track
  },
  stopUsingTrack(dependantId) {
    if (!dependantId)
      throw new Error(
        'Cannot call stopUsingTrack() without specifying a dependant ID',
      )
    log('stopUsingTrack()', { dependantId }, this.kind, this.label)
    this.dependants.delete(dependantId)

    // If nothing locally is rendering our track, stop it.
    // TBH, it's a little weird that it's possible to send a track without displaying it locally.
    // Big brother, take note.
    if (this.dependants.size === 0) {
      if (this.consumer) {
        this.pause()
      } else {
        this.close()
      }
    }
    return this.track
  },
  clearTrack() {
    if (this.track) {
      this.track.onended = () => {}
      this.track.stop()
      this.unset('track')
    }
  },
  close() {
    if (this.state === STATE.inactive) return this
    this.clearTrack()

    window.clearTimeout(this.newLocalTrackTimeout)

    // If something is still dependant on the track, re-initialize it locally (unless it's being consumed)
    if (!this.consumer && this.dependants.size > 0) {
      this.state = STATE.local
      // We need to throttle in case dependants are unloading in parallel
      this.newLocalTrackTimeout = window.setTimeout(() => {
        this.initializeLocalTrack(this.deviceId)
      }, 1000)
    } else {
      // We are now "inactive", which indicates we have no intent of being active
      this.state = STATE.inactive
    }

    // When a producer is closed, the media can be re-activated
    if (this.producer) {
      this.producer.removeAllListeners()
      if (!this.producer.closed) this.producer.close()
    }

    // When a consumer is closed, it will remain inactive until a new consumer is received through RTP
    if (this.consumer) {
      if (!this.consumer.closed) this.consumer.close()
      this.consumer.removeAllListeners()
    }

    return this
  },
  enableStats(interval = 8000, consumer = false) {
    // Begins listening to RTC Stats and emits through 'stats' event
    if (this.producer) this.producer.enableStats(interval)
    this.on('change:producer', () => this.enableStats())
    if (consumer) {
      if (this.consumer) this.consumer.enableStats(interval)
      this.on('change:consumer', () => this.enableStats())
    }
  },
  disableStats() {
    if (this.producer) this.producer.disableStats()
    if (this.consumer) this.consumer.disableStats()
    this.off('change:consumer')
    this.off('change:producer')
  },
  logEvent(name, data = {}) {
    try {
      this.room.logEvent(name, {
        state: this.state,
        media: this.id,
        device: this.getDeviceInfo(),
        ...data,
      })
    } catch (e) {
      warn('Media:logEvent() failed', e, { name, data })
    }
  },
  getDeviceInfo() {
    if (this.consumer) {
      return this.consumer.appData
    } else {
      const device = this.manager.getDeviceByIdAndType(this.deviceId, this.type)
      return {
        deviceId: this.deviceId,
        deviceLabel: device && device.label,
        isHighFidelity: device && device.isHighFidelity,
        type: this.type,
      }
    }
  },
  getModel() {
    return this.manager.getModelForMedia(this)
  },
  async setHighFidelityState(isHighFidelity = false) {
    const model = this.getModel()
    if (!model) return
    model.isHighFidelity = isHighFidelity
    this.isHighFidelity = isHighFidelity

    if (this.producer) {
      this.logEvent('isHighFidelityChanged', { producerId: this.producer.id })
    }
  },
})

const MediaCollection = Collection.extend({
  model: Media,
  initialize() {},
})

export { Media, MediaCollection }
