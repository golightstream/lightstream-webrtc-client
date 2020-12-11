'use strict'

import State from 'ampersand-state'
import Collection from 'ampersand-rest-collection'
import protooClient from 'protoo-client'
import * as mediasoupClient from 'mediasoup-client'
import randomstring from 'randomstring'
import { PeerCollection, Peer } from './peer'
import { MediaCollection, Media } from './media'
import Message from './message'
import Observable from './_observable'
import {
  whereEq,
  pickBy,
  filter,
  pipe,
  prop,
  path,
  assoc,
  reduce,
  both,
  pathEq,
} from 'ramda'
import { debounce, map, pick, result } from 'lodash/fp'
import debug from 'debug'

const log = debug('Lightstream:WebRTC:Room')
const warn = debug('Lightstream:WebRTC:Room (Warn)')

const ROOM_OPTIONS = {
  requestTimeout: 10000,
  transportOptions: { tcp: false },
}
const STATE = {
  connecting: 'connecting',
  preparing: 'preparing',
  connected: 'connected',
  reconnecting: 'reconnecting',
  closed: 'closed',
}

const isMediaActive = pipe(path(['track', 'enabled']), Boolean)
const isMediaLive = pathEq(['track', 'readyState'], 'live')
const isMediaActiveAndLive = both(isMediaActive, isMediaLive)

const partition = {
  active: [],
  inactive: [],
}
const partitionMedia = reduce((acc, media) => {
  const group = isMediaActiveAndLive(media) ? 'active' : 'inactive'
  return assoc(group, [...acc[group], media], acc)
}, partition)

const isAcceptableMedia = (values) => whereEq(pickBy(Boolean, values))

const partitionMatchingMedia = (values) =>
  pipe(filter(isAcceptableMedia(values)), partitionMedia)
const watchers = {}

async function getProtooUrl(peerId, roomId, hostname, port, attempt = 0) {
  try {
    const response = await fetch(
      `https://${hostname}/api/webrtc/room/${roomId}`,
      { headers: new Headers({ 'Content-Type': 'application/json' }) },
    )
    const { host } = await response.json()
    if (host) {
      hostname = host
    }
  } catch (e) {
    // 404 Room does not exist
  }

  return `wss://${hostname}:${port}/?peer-id=${peerId}&room-id=${roomId}&attempt=${attempt}`
}

const Room = State.extend(Observable).extend({
  isAcceptableMedia,
  SHARED_PROPS: [
    'isHost',
    'displayName',
    'device',
    'isUser',
    'isVisible',
    'userWebcamId',
    'userMicrophoneId',
  ],
  TRACK_PROPS_ROOM: ['id', 'isHost', 'displayName', 'guestCount', 'peerId'],
  TRACK_PROPS_TRANSPORT: ['id', '_settings'],
  props: {
    id: 'any',
    code: 'string',
    peerId: 'any',
    protoo: 'object',
    mediasoupRoom: 'object',
    displayName: 'string',
    myPeer: 'state',
    manager: 'state',
    accept: [
      'object',
      true,
      () => ({ deviceId: null, peerId: null, type: null }),
    ],
    device: ['object', true, () => mediasoupClient.getDeviceInfo()],
    state: ['string', true, STATE.closed], // connecting/preparing/connected/reconnecting/closed
    isUser: ['boolean', true, false], // Is this a human peer or an external service feed?
    isHost: ['boolean', true, false],
    isVisible: ['boolean', true, false], // Used to enable host to be in room but not visible to guests
    isHostJoined: ['boolean', true, false],
    ignoreRemoteDeviceIds: ['boolean', true, false],
    ownerName: 'string',
    serverHostname: 'string',
    serverPort: 'number',
    canSendMic: ['boolean', true, false],
    canSendWebcam: ['boolean', true, false],
    restartIceInProgress: ['boolean', true, false],
    isSpeakerSelectionSupported: ['boolean', true, false],
    maxGuests: ['number', true, 8],
    guestCount: ['number', true, 0],
    userCount: ['number', true, 0],
    speakerDeviceId: 'string', // Refers to user media 'audiooutput'
    userWebcamId: 'string', // The deviceId intended to be shared with other greenroom guests
    userMicrophoneId: 'string', // The deviceId intended to be shared with other greenroom guests
    activeSpeaker: 'string',
    send: 'boolean',
    recv: 'boolean',
    statsEnabled: ['boolean', true, false],
    eventLog: ['array', true, () => []], // A timeline of all events which have impacted the state of the room
    // Exception tracking
    hasStateMismatch: ['boolean', true, false],
    isReconcilingState: ['boolean', true, false],
  },
  collections: {
    eventMessages: Collection.extend({
      model: Message,
      comparator: 'timestamp',
    }),
    chatMessages: Collection.extend({
      model: Message,
      comparator: 'timestamp',
    }),
    peers: PeerCollection,
    media: MediaCollection,
  },
  initialize(options = {}) {
    log('Creating room...', ...arguments)
    this.isSpeakerSelectionSupported =
      typeof HTMLVideoElement.prototype.setSinkId === 'function'

    // If we don't receive a peerId, generate a random one
    this.peerId = this.peerId || randomstring.generate()
    this.listenToAndRun(this.peers, 'change change:length', () => {
      this.isHostJoined = Boolean(
        this.peers.find({ isHost: true, isVisible: true }),
      )
      this.guestCount = this.peers.filter({
        isUser: true,
        isVisible: true,
      }).length
      this.userCount = this.guestCount + (this.isUser && this.isVisible ? 1 : 0)
    })

    const myPeerChangeEvents = map((x) => `change:${x}`)(this.SHARED_PROPS)

    const localPeerChange = (props) => {
      this.myPeer.set(props)
      this.set(props)
      this.peers.trigger('change')
    }

    // Set local peer data
    const peerData = pick(this.SHARED_PROPS)(this)
    peerData.isLocal = true
    peerData.id = this.peerId
    peerData.room = this
    this.myPeer = new Peer(peerData)

    const debouncedSendPeerData = debounce(600)(this.sendPeerData.bind(this))
    this.myPeer.on(myPeerChangeEvents.join(' '), () =>
      localPeerChange(pick(this.SHARED_PROPS)(this.myPeer)),
    )
    this.on(myPeerChangeEvents.join(' '), () =>
      localPeerChange(pick(this.SHARED_PROPS)(this)),
    )
    this.peers.on('change', debouncedSendPeerData, this)

    if (!this.displayName) {
      this.displayName = this.isHost ? 'Host' : 'Guest'
    }

    this.mediasoupRoom = new mediasoupClient.Room(ROOM_OPTIONS)

    this.on('change:userWebcamId', () => {
      this.addMedia({ type: 'webcam', deviceId: this.userWebcamId })
    })
    this.on('change:userMicrophoneId', () => {
      this.addMedia({ type: 'microphone', deviceId: this.userMicrophoneId })
    })

    this.on('change:state', () => {
      log('Greenroom state: ' + this.state + '...', this.id)
      this.trigger(`state:${this.state}`)
      this.logEvent('GreenroomStateChanged:' + this.state, {
        state: this.state,
      })
    })
  },
  async open() {
    log('Opening socket connection...', this.getTrackingProps())

    this.state = STATE.connecting

    this.mediasoupRoom._settings.turnServers = await this.waitFor(
      'turnServers',
      this.manager,
    )

    // Initiate transport
    const protooUrl = await getProtooUrl(
      this.peerId,
      this.id,
      this.serverHostname,
      this.serverPort,
    )
    this.protooTransport = new protooClient.WebSocketTransport(protooUrl, {
      retry: { factor: 2, forever: true, minTimeout: 100, maxTimeout: 10000 },
    })
    this.protoo = new protooClient.Peer(this.protooTransport)

    // Handle socket disconnect (connection was previously established)
    // This is not triggered by socket 'close' event
    this.protoo.on('disconnected', () => {
      warn('Lost websocket connection...')

      this.leave({ withIntentToRejoin: this.state === STATE.connected })
      this.state = STATE.reconnecting
      this.status({ status: 'Connection to media server interrupted...' })
      this.once('state:connected', () =>
        this.notification('Connection to media server has been restored'),
      )
    })

    // Handle socket failure (may happen during initial connection or during reconnection)
    this.protoo.on('failed', async (attempt) => {
      warn('protoo Peer "failed" event attempt ' + attempt)

      if (this.state === STATE.connecting)
        this.status({ status: 'Attempting to connect to media server...' })
      this.protooTransport._url = await getProtooUrl(
        this.peerId,
        this.id,
        this.serverHostname,
        this.serverPort,
        attempt,
      )
    })

    // Handle socket close (the session is terminated and must be recreated)
    this.protoo.on('close', () => {
      warn('protoo Peer "close" event')
      this.trigger('close:unexpected')
      this.close()
    })
    this.protoo.on('request', this._handleProtooRequest.bind(this))

    return new Promise((resolve) => {
      // Protoo event handlers
      this.protoo.on('open', () => {
        this.trigger('status:resolve')
        log('protoo Peer "open" event')
        this.state = STATE.connecting // Sort of a misnomer - "connecting" means that we have not yet joined the room
        if (this.intentToJoin) {
          return this.join()
        } else {
          return resolve(this)
        }
      })
    })
  },
  async join() {
    log('Joining room...')
    this.state = STATE.preparing
    this.logEvent('JoinRoom', { state: this.state })

    // Store intentToJoin to determine whether we should rejoin in the event of a network hiccup
    this.intentToJoin = true

    // Mediasoup event handlers.
    // We generally only listen to these -
    // Custom events should be sent through the protoo peer
    this.mediasoupRoom.removeAllListeners()
    this.mediasoupRoom.on('close', (originator, appData) => {
      if (originator === 'remote') {
        warn('Room remotely closed', appData)
        this.close()
      }
    })
    this.mediasoupRoom.on('request', (request, callback, errback) => {
      log('sending mediasoup request', request)
      this.protoo
        .send('mediasoup-request', request)
        .then(callback)
        .catch(errback)
    })
    this.mediasoupRoom.on('notify', (notification) => {
      log('sending mediasoup notification', notification)
      this.protoo
        .send('mediasoup-notification', notification)
        .catch((error) => {
          warn('could not send mediasoup notification', error)
        })
    })
    this.mediasoupRoom.on('newpeer', (peer) => {
      log('room "newpeer" event', peer)
      const reject = this._handlePeer(peer)
      if (reject) {
        this.sendEvent('kick', { id: peer.name })
      } else if (peer.appData.isVisible && peer.appData.isUser) {
        this.notifyJoin(peer.appData.displayName)
      }
    })

    if (!this.isHost) {
      this.isVisible = true
    }
    // Start the procedures to join a remote room.
    // Returns a Promise resolving with an Array of remote Peer instances already in the room.
    const peerData = pick(this.SHARED_PROPS)(this.myPeer)
    return this.mediasoupRoom
      .join(this.peerId, peerData)
      .then(() => this._onJoin())
  },
  leave(options = {}) {
    try {
      log('Leaving room...', ...arguments)
      const { withIntentToRejoin } = options
      this.logEvent('LeaveRoom', { state: this.state })

      withIntentToRejoin || this.exit(true)
      this.intentToJoin = Boolean(withIntentToRejoin)
      this.state = STATE.preparing
      this.media.models.forEach((x) => x.close())
      this._sendTransport && this._sendTransport.removeAllListeners()
      this._recvTransport && this._recvTransport.removeAllListeners()
      this.mediasoupRoom.leave()
      this.mediasoupRoom.removeAllListeners()
    } catch (e) {
      this.close()
    }
  },
  close(withIntentToLeave = false) {
    if (this.state === STATE.closed) {
      log('Cannot close (already closed)')
      return
    }
    log('Closing websocket connection...', ...arguments)
    this.logEvent('CloseRoom', { state: this.state })
    withIntentToLeave && this.exit(true)
    this.intentToJoin = false
    this.mediasoupRoom.leave()
    this.media.forEach((x) => x.close())
    if (this.protoo) {
      this.protoo.removeAllListeners()
      this.protoo.close()
    }
    this.state = STATE.closed
  },
  async _onJoin() {
    const handleTransportStateChange = (transport) => (state) => {
      if (state === 'connected') {
        if (this.statsEnabled) {
          // Run again to ensure transports
          this.enableStats()
        }
        return (this.state = STATE.connected)
      }
      if (state === 'closed') {
        this.logEvent('TransportClosedUnexpectedly', { state: this.state })
        warn(`Transport closed (${transport.direction})...`, transport)

        // Close the room since we can't work without a transport
        this.trigger('close:unexpected')
        return this.close()
      }
      if (state === 'failed') {
        this.logEvent('TransportConnectionFailed', { state: this.state })
        warn('ICE Transport failed...', transport)
        this.state = STATE.reconnecting
        return this.mediasoupRoom.restartIce()
      }
    }

    // Override minptime on join
    this.mediasoupRoom._extendedRtpCapabilities.codecs
      .filter((x) => x.kind === 'audio')
      .forEach((x) => (x.parameters.minptime = 40))

    if (this.send) {
      this._sendTransport = this.mediasoupRoom.createTransport('send', {
        peerId: this.peerId,
      })
      this._sendTransport.on(
        'connectionstatechange',
        handleTransportStateChange(this._sendTransport),
      )
    }

    // Create Transport for receiving.
    if (this.recv) {
      this._recvTransport = this.mediasoupRoom.createTransport('recv', {
        peerId: this.peerId,
      })
      this._recvTransport.on(
        'connectionstatechange',
        handleTransportStateChange(this._recvTransport),
      )
    }

    const peers = this.mediasoupRoom.peers
    for (const peer of peers) {
      this._handlePeer(peer, { notify: false })
    }

    // Transmit application data about our peer to other peers
    this.sendEvent('peerdata', pick(this.SHARED_PROPS)(this.myPeer))

    this.state = STATE.connected
    this.media.forEach((x) => x.activate())
  },
  _handleProtooRequest(request, accept, reject) {
    switch (request.method) {
      case 'event': {
        accept()

        if (
          request.data.name === 'isHighFidelityChanged' ||
          request.data.name === 'ChangeProducerDevice'
        ) {
          const {
            data: {
              data: { device },
            },
          } = request
          const mediaModel = this.media.findWhere({
            peerId: request.data.peer,
            type: device.type,
          })

          if (mediaModel) {
            mediaModel.isHighFidelity = Boolean(device.isHighFidelity)
          }
        }

        this.eventLog = this.eventLog.concat(request.data)
        break
      }
      case 'heartbeat': {
        accept()

        // Ignore heartbeat if we haven't joined the room,
        //  since we'll have no sense of mediapeers until then
        if (this.state !== 'connected') return

        const { peers } = request.data
        const localPeers = [this.myPeer, ...this.peers.models]

        // Check whether our state matches the room on the server
        if (!this.hasStateMismatch && peers.length !== localPeers.length) {
          this.logEvent('StateException', {
            kind: 'PeerMismatch',
            local: localPeers.map((x) => x.id),
            server: peers.map((x) => x.id),
          })
          this.hasStateMismatch = true
        } else if (this.hasStateMismatch) {
          // State was mismatched but has reconciled.
          // Report the reconciliation of state
          this.logEvent('StateRecovery')
          this.hasStateMismatch = false
          this.isReconcilingState = false
        }

        // If the state was mismatched and has not been reconciled, force a reconnect.
        //  We'll not attempt this if state has since failed to reconcile.
        if (this.hasStateMismatch && !this.isReconcilingState) {
          this.isReconcilingState = true
          this.close()
          this.open().then((x) => x.join())
        }

        // Synchronize our peer state with what exists on the server
        //  This is a simple data sync in case inconsequential messages were missed
        peers.forEach((peerData) => {
          const peer = localPeers.find((peer) => peer.id === peerData.id)
          if (peer) peer.set(peerData.appData)
        })

        break
      }
      case 'mediasoup-notification': {
        accept()
        const notification = request.data

        try {
          this.mediasoupRoom.receiveNotification(notification)
        } catch (e) {
          warn('Failed to handle mediasoup notification', {
            notification,
            error: e,
          })
        }
        break
      }
      case 'active-speaker': {
        accept()
        const { peerName: peerId } = request.data
        if (peerId === this.peerId) {
          // Is self
          this.activeSpeaker = 'Self'
        } else if (peerId) {
          // Is other
          const activePeer = this.peers.get(peerId)
          this.activeSpeaker = activePeer ? activePeer.displayName : null
        } else {
          this.activeSpeaker = null
        }
        break
      }
      case 'message': {
        accept()
        this._onMessage(request.data)
        break
      }
      default: {
        warn('Unknown protoo method/request', request.method)
        reject(404, 'unknown method')
      }
    }
  },
  sendPeerData() {
    const props = pick(this.SHARED_PROPS)(this.myPeer)
    this.sendEvent('peerdata', props)
  },
  getTrackingProps() {
    return Object.assign({}, pick(this.TRACK_PROPS_ROOM, this), {
      sendTransport: pick(this.TRACK_PROPS_TRANSPORT, this._sendTransport),
      recvTransport: pick(this.TRACK_PROPS_TRANSPORT, this._recvTransport),
      hasMultipleWebsocketConnections:
        result('app.database.server.totalSessions', window) > 1,
      device: this.manager.device.bowser,
      webcamsAvailable: this.manager.webcams.map(
        pick(['deviceId', 'displayName']),
      ),
      microphonesAvailable: this.manager.microphones.map(
        pick(['deviceId', 'displayName']),
      ),
      producers:
        this.mediasoupRoom &&
        this.mediasoupRoom.producers.map(result('appData')),
    })
  },
  _handlePeer(peer) {
    const { appData: sharedProps, name: id } = peer

    // Ignore the peer if the room is full.
    //  TODO: This should be on the server side.
    const guestPeers = [...this.peers.models, this.myPeer].filter(
      (x) => !x.isHost && x.isUser,
    ).length
    if (
      this.myPeer.isUser &&
      sharedProps.isUser &&
      !sharedProps.isHost &&
      guestPeers >= this.maxGuests
    ) {
      return true
    }

    log('Received peer', name, sharedProps)
    const model = new Peer(
      Object.assign({ id, allMedia: this.media, room: this }, sharedProps),
    )
    this.peers.add(model)

    // Hosts don't join on connect, since they are always connected - they join on change of isVisible
    if (model.isUser && !model.isVisible) {
      this.listenTo(model, 'change:isVisible', () => {
        if (model.isVisible) {
          this.notifyJoin(model.displayName)
        } else {
          this.notifyLeave(model.displayName)
        }
      })
    }

    for (const consumer of peer.consumers) {
      this._handleConsumer(consumer)
    }

    // Peer event handlers
    peer.on('close', (originator) => {
      log('peer "close" event', { peer }, { originator })
      this.peers.remove(model)
      if (this.mediasoupRoom.joined && model.isUser && model.isVisible) {
        log(`${model.displayName} left the room`)
        this.notifyLeave(model.displayName)
      }
    })
    peer.on('newconsumer', (consumer) => {
      log('peer "newconsumer" event', name, { consumer })
      this._handleConsumer(consumer)
    })
  },
  async _handleConsumer(consumer) {
    log('_handleConsumer()', consumer)

    // Find the peer model that corresponds to this consumer
    const peer = this.peers.find((x) => x.id === consumer.peer.name)
    const peerId = consumer.peer.name

    // Pull the application data from the consumer
    let { type, deviceId } = consumer.appData
    const isHighFidelity = Boolean(consumer.appData.isHighFidelity)

    // VALIDATION: Don't consume any RTP that we don't need

    // Custom media validation that is passed on room init
    const unacceptable = !isAcceptableMedia(this.accept)({
      deviceId,
      peerId,
      type,
    })

    // Users ignore screenshare audio from other users
    const userReceivingUserBrowserAudio =
      this.isUser && peer && peer.isUser && type === 'audio'

    // Browser cannot handle this codec
    const unsupportedCodec = !consumer.supported

    if (unacceptable || userReceivingUserBrowserAudio || unsupportedCodec) {
      log(
        'ignoring consumer because it did not pass validation',
        { unacceptable, userReceivingUserBrowserAudio, unsupportedCodec },
        { consumer },
      )
      return consumer.close()
    }

    // Attempt to find an existing consumer with the same deviceId
    // We will use this to connect a media object to its consumer
    // in the event that the server restarts, or the peer reconnects
    const codec = consumer.rtpParameters.codecs[0]
    const mediaData = {
      consumer,
      peerId,
      type,
      deviceId,
      id: consumer.id,
      isHighFidelity,
      room: this,
      codec: codec ? codec.name : null,
      manager: this.manager,
    }

    // Audio that comes from a source that isn't using mediasoup-client
    // probably won't specify a "type", so we set a default
    if (!type) {
      mediaData.type = consumer.kind === 'audio' ? 'audioFeed' : 'videoFeed'
    }

    mediaData.displayName = peer ? `${peer.displayName}'s ${type}` : ''

    // We might already have an inactive media that matches the incoming consumer
    const existing = this.getMatchingMedia({
      type,
      deviceId,
      peerId,
      isHighFidelity,
    })
    const media = existing || new Media(mediaData)

    // If it already exists, update the media with the new consumer and activate (receive) it
    if (existing && existing.consumer !== mediaData.consumer) {
      existing.close()
      existing.set(mediaData.consumer.appData)
      existing.consumer = mediaData.consumer
      existing.state = 'preparing'
      media.activate()
    } else {
      // Otherwise, receive it and then add it to our list of media
      media.activate().then(() => {
        this.media.add(media)
        media.triggerUpdate()
      })
    }

    media.consumer.on('close', () => {
      this.media.remove(media.id)
      media.triggerUpdate()
    })
  },
  watch(mediaValues = {}, dependantId, cb = () => {}, options = {}) {
    if (!dependantId)
      throw new Error('Must specify a dependantId to watch media')
    if (watchers[dependantId])
      return warn('Already watching media with dependantId', { dependantId })
    const info = debug('Lightstream:WebRTC:Watch')
    info('Watching for media', { dependantId, mediaValues })
    this.logEvent('WatchForMedia', { mediaValues })

    const partition = partitionMatchingMedia(mediaValues)
    const updateResult = async () => {
      // If our previous track is still active, just return
      if (isMediaActiveAndLive(watchers[dependantId]))
        return info('Ignoring media update: Already have a live track')

      const { active, inactive } = partition(this.media.models)
      const matchingMedia = active[0] || inactive[0]

      info(
        'Looking for media match',
        { dependantId, match: mediaValues },
        {
          candidates: this.media.map(
            pick(['type', 'peerId', 'deviceId', 'track']),
          ),
        },
      )

      // Use the media's track if it has one, else it will give us a new one
      if (matchingMedia) await matchingMedia.useTrack(dependantId)

      // We need to run this check again due a race condition with useTrack()
      if (isMediaActiveAndLive(watchers[dependantId]))
        return info('Ignoring media update: Already have a live track')

      // We won't report a track to our watcher if it isn't active
      const track = prop('track', matchingMedia)

      const result = {
        media: matchingMedia,
        track,
      }
      const prev = watchers[dependantId] || {}
      info('Latest track received for media', { dependantId }, result)

      // If the track hasn't changed, there is no need to inform the watchers
      if (prev.track === result.track)
        return info('Ignoring media update: Track is identical')

      // Include a cast to MediaStream for convenience
      result.srcObject = track ? new MediaStream([track]) : null

      // Begin gathering audio level information if requested
      if (result.media && options.audioLevels && this.isHost) {
        result.media.useAudioLevels(dependantId, result.srcObject)
      }

      // Update the watchers
      watchers[dependantId] = result

      info('Sending media update to watcher', result, mediaValues)
      if (track) {
        this.logEvent('MediaFoundForWatcher', { mediaValues })
      }
      cb(result, prev)
    }

    // Run the initial check for a match
    updateResult()

    const onMediaUpdate = async (triggeredVals = {}) => {
      // We only care about updates triggered by a potential match
      if (isAcceptableMedia(mediaValues)(triggeredVals)) updateResult()
    }
    this.listenTo(this, 'MediaUpdate', onMediaUpdate)

    // Return a hook to stop listening for the media
    return () => {
      info('Stop watching media', { dependantId, mediaValues })
      this.stopListening(this, 'MediaUpdate', onMediaUpdate)

      if (!watchers[dependantId]) {
        warn(
          'The listener for this dependant has already been nullified. Double check your bindings.',
          { dependantId },
        )
      } else {
        const { media } = watchers[dependantId]
        if (media) {
          media.stopUsingTrack(dependantId)
          if (options.audioLevels) {
            media.stopUsingAudioLevels(dependantId)
          }
        }
      }

      cb(
        {
          track: null,
          media: null,
          srcObject: null,
        },
        watchers[dependantId] || {},
      )
      watchers[dependantId] = null
    }
  },
  getMatchingMedia(values = {}) {
    return this.media.find(isAcceptableMedia(values))
  },
  async addMedia(props) {
    const { type, deviceId, track } = props
    const peerId = this.myPeer.id

    // "type" is required
    if (!type) throw new Error('Cannot add a media without a "type"')
    if (type === 'screen' && !props.track) {
      warn('Did you mean to add a screen without a track?')
    }

    // If we have an exact match that isn't closed, just return it
    const existing = this.getMatchingMedia({ type, deviceId, peerId })
    if (existing) {
      if (track && track.readyState === 'live') existing.updateTrack(track)
      existing.activate()
      return existing
    }

    const media = new Media({
      ...props,
      peerId,
      id: randomstring.generate(),
      room: this,
      manager: this.manager,
      simulcast: false,
    })
    this.media.add(media)
    media.triggerUpdate()

    this.myPeer[type] = media
    return media
  },
  pushLocalChatAlert(text) {
    const timestamp = Date.now()
    const id = randomstring.generate()
    const alert = new Message({
      id,
      timestamp,
      text,
      type: 'chat',
      isAlert: true,
    })
    this.chatMessages.add(alert)
  },
  status({ status, action }) {
    // `status:resolve` will be triggered at a later time
    this.trigger('status', { status, action })
  },
  notification(notification, options = {}) {
    this.trigger('notification', notification, options)
  },
  notifyJoin(displayName) {
    if (this.state !== STATE.connected) return
    const notification = `${displayName} joined the room`
    this.pushLocalChatAlert(notification)
    this.notification(notification)
  },
  notifyLeave(displayName) {
    if (this.state !== STATE.connected) return
    const notification = `${displayName} left the room`
    this.pushLocalChatAlert(notification)
    this.notification(notification)
  },
  exit(silent = false) {
    if (!silent) {
      this.logEvent('BecomeInvisible', { state: this.state })
    }
    this.isVisible = false
  },
  async enter() {
    this.logEvent('BecomeVisible', { state: this.state })
    this.isVisible = true
    await this.manager.updateDevices()
    this.addMedia({ type: 'microphone', deviceId: this.userMicrophoneId })
    this.addMedia({ type: 'webcam', deviceId: this.userWebcamId })
  },

  // Data channel
  _sendMessage({ type, info, destinationPeerId }) {
    if (!this.protoo) return // Return if the messaging socket is not available
    log('sendMessage()', ...arguments)
    const timestamp = Date.now()
    const id = randomstring.generate()
    const props = {
      id,
      type,
      timestamp,
      peerId: this.peerId,
      username: this.displayName,
      isRemote: false,
      uri: info.uri,
      text: info.text,
      name: info.name,
      data: info.data || {},
    }
    const model = new Message(props)
    model.peer = this.myPeer

    if (type === 'chat') {
      log('Sent chat message:', { message: props })
      this.chatMessages.add(model)
    } else if (type === 'event') {
      log('Sent event:', { event: props })
      this.eventMessages.add(model)
    }
    return this.protoo
      .send('message', { message: props, destinationPeerId })
      .catch((e) => {
        console.warn('Failed to send protoo message', e)
      })
  },
  _onMessage(props = {}) {
    props.peer = this.peers.get(props.peerId)

    delete props.peerId
    props.isRemote = true
    const model = new Message(props)

    if (props.type === 'chat') {
      log('Received chat message:', { message: props })
      this.chatMessages.add(model)
    } else if (props.type === 'event') {
      log(`Received event: ${props.name}`, { event: props })
      this.eventMessages.add(model)
      const event = props.name
      switch (event) {
        // Message event handlers
        case 'disney': {
          if (!this.isHost) window.location = 'https://disney.com'
          break
        }
        case 'kick': {
          if (!this.isHost && props.data.id === this.myPeer.id) {
            this.leave()
            this.trigger('kicked')
          }
          break
        }
        case 'peerdata': {
          if (props.peer) props.peer.set(props.data)
          break
        }
        case 'enableStats': {
          this.enableStats(true)
          break
        }
        case 'disableStats': {
          this.disableStats(true)
          break
        }
        default: {
          this.trigger(event, props.data)
        }
      }
    }
  },
  sendEvent(name = '', data = {}, destinationPeerId = null) {
    return this._sendMessage({
      type: 'event',
      info: { name, data },
      destinationPeerId,
    })
  },
  sendChatMessage(text = '', destinationPeerId = null) {
    return this._sendMessage({
      type: 'chat',
      info: { text },
      destinationPeerId,
    })
  },
  sendChatImage(uri = '', destinationPeerId = null) {
    return this._sendMessage({ type: 'chat', info: { uri }, destinationPeerId })
  },
  logEvent(name, data = {}) {
    return this._sendMessage({ type: 'ui-event', info: { name, data } })
  },
  flushEvents(send = false) {
    this.eventLog = []
    if (send) {
      this.protoo.send('flush-events')
    }
  },
  banhammer() {
    if (this.isHost) {
      this.sendEvent('disney')
    }
  },
  enableStats(silent = false) {
    this.statsEnabled = true
    this._sendTransport && this._sendTransport.enableStats(8 * 1000)
    this._recvTransport && this._recvTransport.enableStats(8 * 1000)
    if (!silent) this.sendEvent('enableStats')
  },
  disableStats(silent = false) {
    this.statsEnabled = false
    this._sendTransport && this._sendTransport.disableStats()
    this._recvTransport && this._recvTransport.disableStats()
    if (!silent) this.sendEvent('disableStats')
  },
})

const RoomCollection = Collection.extend({ model: Room })

export { Room, RoomCollection }
