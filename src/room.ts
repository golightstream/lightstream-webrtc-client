import protooClient from 'protoo-client'
import * as mediasoupClient from 'mediasoup-client'
import { Machine, assign, spawn, send } from 'xstate'
import { MachineOptions } from 'xstate/lib/types'
import {
  Transport,
  Notification,
  RoomMachineContext,
  RoomCommandEvent,
  RoomMachineSchema,
  VideoDefinition,
  RoomRequestEvent,
  AudioDefinition,
  RoomMachineEvent,
  RoomNotificationEvent,
  MediaActor,
} from './index'
import { mediaMachine } from './media'

const VIDEO_CONSTRAINTS = {
  qvga: { width: { ideal: 320 }, height: { ideal: 240 } },
  vga: { width: { ideal: 640 }, height: { ideal: 480 } },
  hd: { width: { ideal: 1280 }, height: { ideal: 720 } },
} as const

const PC_PROPRIETARY_CONSTRAINTS = {
  optional: [{ googDscp: true }],
} as const

// Used for simulcast webcam video.
const WEBCAM_SIMULCAST_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 500000 },
  { scaleResolutionDownBy: 2, maxBitrate: 1000000 },
  { scaleResolutionDownBy: 1, maxBitrate: 5000000 },
] as const

// Used for VP9 webcam video.
const WEBCAM_KSVC_ENCODINGS = [
  { scalabilityMode: 'S3T3_KEY' },
]

// Used for simulcast screen sharing.
const SCREEN_SHARING_SIMULCAST_ENCODINGS = [
  { dtx: true, maxBitrate: 1500000 },
  { dtx: true, maxBitrate: 6000000 },
]

// Used for VP9 screen sharing.
const SCREEN_SHARING_SVC_ENCODINGS = [
  { scalabilityMode: 'S3T3', dtx: true },
]

// Informative events that are emitted but not saved as state
const DIAGNOSTIC_NOTIFICATIONS = [
  'downlinkBwe',
  'consumerLayersChanged',
  'consumerScore',
]

export const roomServices: MachineOptions<
  RoomMachineContext,
  RoomMachineEvent
>['services'] = {
  notificationHandler: () => (sendBack, onReceive) =>
    onReceive(async (event) => {
      const {
        notification,
        context,
      } = event as RoomNotificationEvent
      const onError = (reason: string) => {
        sendBack({
          type: 'NOTIFICATION_ERROR',
          name: notification.name,
          reason,
        })
      }

      console.log(
        `Notification received: ` +
          `%c${notification.name}`,
        'color:#777;font-size:11px;',
        notification,
      )

      try {
        const { data } = notification

        switch (notification.name) {
          case 'newPeer': {
            return sendBack({
              type: 'PEER_JOINED',
              peer: {
                id: data.id,
                info: data.info,
                device: data.device,
              },
            })
          }
          case 'peerClosed': {
            const peerMedia = context.media.filter(
              (x) => x.peerId === data.peerId,
            )
            peerMedia.forEach((x) => x.consumer?.close())
            return sendBack({
              type: 'PEER_LEFT',
              peerId: data.peerId,
            })
          }
          case 'peerUpdated': {
            return sendBack({
              type: 'PEER_UPDATED',
              peerId: data.peerId,
              info: data.info,
            })
          }
          case 'consumerClosed': {
            const { consumerId } = notification.data
            return send('CLOSED', { to: consumerId })
          }
        }
      } catch (e) {
        console.error(e)
        onError(e.message)
      }
    }),
  requestHandler: () => (sendBack, onReceive) =>
    onReceive(async (event) => {
      const {
        request,
        context,
        accept,
        reject,
      } = event as RoomRequestEvent
      const { recvTransport } = context
      console.log(
        `Request received: ` + `%c${request.name}`,
        'background-color:#88c6e4;color:#111;font-size:15px;font-weight:bold;',
        request,
      )

      try {
        /**
         * Request handlers
         */
        switch (request.name) {
          case 'newConsumer': {
            const {
              peerId,
              producerId,
              id,
              kind,
              rtpParameters,
              appData,
            } = request.data

            const consumer = await recvTransport.consume({
              id,
              producerId,
              kind,
              rtpParameters,
              appData: { ...appData, peerId },
            })
            consumer.on('transportclose', () => {
              console.log(
                'Consumer transport closed',
                consumer.id,
              )
            })

            sendBack({
              type: 'REMOTE_MEDIA_ADDED',
              media: {
                id: consumer.id,
                track: consumer.track,
                consumer,
                peerId,
                kind: consumer.kind,
                ...consumer.appData,
              },
            })
            return accept()
          }
        }
      } catch (e) {
        reject(e)
      }
    }),
  commandHandler: () => (sendBack, onReceive) => {
    // Begin Helpers:
    const getVideo = async ({
      deviceId,
      resolution,
      constraints,
    }: Partial<VideoDefinition>) => {
      let _constraints = {
        deviceId,
        ...VIDEO_CONSTRAINTS[resolution || 'vga'],
        ...constraints,
      } as MediaTrackConstraints
      const stream = await navigator.mediaDevices.getUserMedia(
        {
          video: _constraints,
        },
      )
      return stream.getVideoTracks()[0]
    }
    const getAudio = async ({
      deviceId,
      constraints,
    }: Partial<AudioDefinition>) => {
      let _constraints = {
        deviceId,
        ...constraints,
      } as MediaTrackConstraints
      const stream = await navigator.mediaDevices.getUserMedia(
        {
          audio: _constraints,
        },
      )
      return stream.getAudioTracks()[0]
    }

    onReceive(async (event) => {
      const { command, context } = event as RoomCommandEvent
      const reject = (reason: string) => {
        sendBack({
          type: 'COMMAND_FAILED',
          name: command.name,
          reason,
        })
      }
      console.log(
        `Command sent: ` + `%c${command.name}`,
        'background-color:#c1ac12;color:#111;font-size:15px;font-weight:bold;',
        command,
      )
      const {
        protoo,
        sendTransport,
        mediasoupDevice,
      } = context

      /**
       * Command handlers
       */
      try {
        switch (command.name) {
          case 'SendAudio': {
            const payload = command.payload as AudioDefinition
            if (!mediasoupDevice.canProduce('audio')) {
              return console.warn('Cannot produce audio')
            }

            const track =
              payload.track || (await getAudio(payload))
            const producer = await sendTransport.produce({
              track,
              codecOptions: {
                opusStereo: true,
                opusDtx: true,
              },
              appData: {
                type: payload.type || 'unknown',
                deviceId: payload.deviceId,
                label: payload.label || ''
              },
              // NOTE: for testing codec selection.
              // codec : mediasoupDevice.rtpCapabilities.codecs
              // 	.find((codec) => codec.mimeType.toLowerCase() === 'audio/pcma')
            })
            producer.on('transportclose', () => {
              send('CLOSED', { to: producer.id })
            })
            if (!track) {
              return reject('Failed to get audio track')
            }
            return sendBack({
              type: 'LOCAL_MEDIA_ADDED',
              media: {
                id: producer.id,
                peerId: context.peerId,
                track,
                producer,
                kind: producer.kind,
                ...producer.appData,
              },
            })
          }
          case 'SendVideo': {
            const payload = command.payload as VideoDefinition
            const { settings, mediasoupDevice } = context
            if (!mediasoupDevice.canProduce('video')) {
              return console.warn('Cannot produce video')
            }

            const track =
              payload.track || (await getVideo(payload))

            let encodings
            let codec
            const codecOptions = {
              videoGoogleStartBitrate: 1000,
            }
            if (settings.forceH264) {
              codec = mediasoupDevice.rtpCapabilities.codecs.find(
                (c) =>
                  c.mimeType.toLowerCase() === 'video/h264',
              )
              if (!codec) {
                throw new Error(
                  'desired H264 codec+configuration is not supported',
                )
              }
            } else if (settings.forceVP9) {
              codec = mediasoupDevice.rtpCapabilities.codecs.find(
                (c) =>
                  c.mimeType.toLowerCase() === 'video/vp9',
              )
              if (!codec) {
                throw new Error(
                  'desired VP9 codec+configuration is not supported',
                )
              }
            }
            if (settings.useSimulcast) {
              // If VP9 is the only available video codec then use SVC.
              const firstVideoCodec = mediasoupDevice.rtpCapabilities.codecs.find(
                (c) => c.kind === 'video',
              )
              if (
                (settings.forceVP9 && codec) ||
                firstVideoCodec.mimeType.toLowerCase() ===
                  'video/vp9'
              ) {
                encodings = WEBCAM_KSVC_ENCODINGS
              } else {
                encodings = WEBCAM_SIMULCAST_ENCODINGS
              }
            }

            const producer = await sendTransport.produce({
              track,
              // @ts-ignore
              encodings,
              codecOptions,
              codec,
              appData: {
                type: payload.type || 'unknown',
                deviceId: payload.deviceId,
                label: payload.label || ''
              },
            })
            if (!track) {
              return reject('Failed to get audio track')
            }

            return sendBack({
              type: 'LOCAL_MEDIA_ADDED',
              media: {
                id: producer.id,
                peerId: context.peerId,
                track,
                producer,
                kind: producer.kind,
                ...producer.appData,
              },
            })
          }
          case 'PauseMedia': {
            const { mediaId } = command.payload
            const media = context.media.find(
              (x) => x.id === mediaId,
            )
            if (!media) return reject('Media not found')
            if (media.consumer) {
              await protoo.request('pauseConsumer', {
                consumerId: media.consumer.id,
              })
              media.consumer.pause()
            }
            if (media.producer) {
              await protoo.request('pauseProducer', {
                producerId: media.producer.id,
              })
              media.producer.pause()
            }
            return media.actor.send('PAUSED')
          }
          case 'ResumeMedia': {
            const { mediaId } = command.payload
            const media = context.media.find(
              (x) => x.id === mediaId,
            )
            if (!media) return reject('Media not found')
            if (media.consumer) {
              if (media.consumer.closed)
                return reject('Media is closed')
              await protoo.request('resumeConsumer', {
                consumerId: media.consumer.id,
              })
              media.consumer.resume()
            }
            if (media.producer) {
              if (media.producer.closed)
                return reject('Media is closed')
              await protoo.request('resumeProducer', {
                producerId: media.producer.id,
              })
              media.producer.resume()
            }
            return media.actor.send({
              type: 'RESUMED',
            })
          }
          case 'StopSendingMedia': {
            const { mediaId } = command.payload
            const media = context.media.find(
              (x) => x.id === mediaId,
            )
            if (!media) return reject('Media not found')
            if (!media.producer)
              return reject('Media is not sending')
            await protoo.request('closeProducer', {
              producerId: media.producer.id,
            })
            media.producer.close()
            return media.actor.send({
              type: 'CLOSED',
            })
          }
          case 'SwitchVideo': {
            const {
              mediaId,
              newDefinition,
            } = command.payload
            const media = context.media.find(
              (x) => x.id === mediaId,
            )
            if (!media) return reject('Media not found')
            if (!media.producer)
              return reject('Media is not sending')

            const track =
              newDefinition.track ||
              (await getVideo(newDefinition))

            if (!track) {
              return reject('Failed to get video track')
            }
            return media.actor.send({
              type: 'SWITCH',
              track,
            })
          }
          case 'SwitchAudio': {
            const {
              mediaId,
              newDefinition,
            } = command.payload
            const media = context.media.find(
              (x) => x.id === mediaId,
            )
            if (!media) return reject('Media not found')
            if (!media.producer)
              return reject('Media is not sending')

            const track =
              newDefinition.track ||
              (await getAudio(newDefinition))

            if (!track) {
              return reject('Failed to get video track')
            }
            return media.actor.send({
              type: 'SWITCH',
              track,
            })
          }
        }

        // If there is no frontend handler, proxy the request directly to the server
        // @ts-ignore
        await protoo.request(command.name, command.payload)
      } catch (e) {
        console.error(e)
        reject(e.message)
      }
    })
  },
  socket: (context) => (sendBack, onReceive) => {
    const protooTransport = new protooClient.WebSocketTransport(
      context.socketUrl,
      {
        retry: {
          retries: 30,
          factor: 2,
          minTimeout: 0.5 * 1000,
          maxTimeout: 10 * 1000,
        },
      },
    )
    const protoo = new protooClient.Peer(protooTransport)

    // Handle connection states
    protoo.on('open', async () => {
      const mediasoupDevice = new mediasoupClient.Device()
      const routerRtpCapabilities = await protoo.request(
        'getRouterRtpCapabilities',
      )
      await mediasoupDevice.load({
        routerRtpCapabilities,
      })
      sendBack({
        type: 'SOCKET.CONNECTED',
        protoo,
        mediasoupDevice,
      })
    })
    protoo.on('failed', () => {
      console.log('Connection failed, retrying...')
      sendBack('SOCKET.FAILED')
    })
    protoo.on('disconnected', () => {
      console.log('Connection lost, reconnecting...')
      sendBack('SOCKET.DISCONNECTED')
    })
    protoo.on('close', () => sendBack('SOCKET.CLOSED'))

    // Handle requests from server
    protoo.on('request', (request, accept, reject) =>
      sendBack({
        type: 'REQUEST',
        request: {
          name: request.method,
          data: request.data,
        },
        accept,
        reject: (reason = 'Not available') =>
          reject(403, reason),
      }),
    )

    // Handle notifications from server
    protoo.on('notification', (protooNotification) => {
      const notification: Notification = {
        name: protooNotification.method,
        data: protooNotification.data,
      }
      const isDiagnosticOnly = DIAGNOSTIC_NOTIFICATIONS.includes(
        notification.name,
      )
      if (isDiagnosticOnly) {
        if (context.onDiagnostics)
          context.onDiagnostics(notification)
      } else {
        sendBack({
          type: 'NOTIFICATION',
          notification,
        })
      }
    })

    return () => {
      protoo.close()
      // TODO: Stop listening
    }
  },
  performJoin: async (context) => {
    const { protoo, settings, mediasoupDevice } = context
    console.log('Execute join...')

    let recvTransport: Transport, sendTransport: Transport
    // Create mediasoup Transport for sending (unless we don't want to produce).
    if (settings.produce) {
      const transportInfo = await protoo.request(
        'createWebRtcTransport',
        {
          forceTcp: settings.forceTcp,
          producing: true,
          consuming: false,
        },
      )

      const {
        id,
        iceParameters,
        iceCandidates,
        dtlsParameters,
        sctpParameters,
      } = transportInfo

      sendTransport = mediasoupDevice.createSendTransport({
        id,
        iceParameters,
        iceCandidates,
        dtlsParameters,
        sctpParameters,
        iceServers: [],
        proprietaryConstraints: PC_PROPRIETARY_CONSTRAINTS,
      })

      sendTransport.on(
        'connect',
        ({ dtlsParameters }, callback, errback) => {
          protoo
            .request('connectWebRtcTransport', {
              transportId: sendTransport.id,
              dtlsParameters,
            })
            .then(callback)
            .catch(errback)
        },
      )

      sendTransport.on(
        'produce',
        async (
          { kind, rtpParameters, appData },
          callback,
          errback,
        ) => {
          try {
            const { id } = await protoo.request('produce', {
              transportId: sendTransport.id,
              kind,
              rtpParameters,
              appData,
            })
            callback({ id })
          } catch (error) {
            errback(error)
          }
        },
      )

      // Create mediasoup Transport for receiving (unless we don't want to consume).
      if (settings.consume) {
        const transportInfo = await protoo.request(
          'createWebRtcTransport',
          {
            forceTcp: settings.forceTcp,
            producing: false,
            consuming: true,
          },
        )

        const {
          id,
          iceParameters,
          iceCandidates,
          dtlsParameters,
          sctpParameters,
        } = transportInfo

        recvTransport = mediasoupDevice.createRecvTransport(
          {
            id,
            iceParameters,
            iceCandidates,
            dtlsParameters,
            sctpParameters,
            iceServers: [],
          },
        )

        recvTransport.on(
          'connect',
          ({ dtlsParameters }, callback, errback) => {
            protoo
              .request('connectWebRtcTransport', {
                transportId: recvTransport.id,
                dtlsParameters,
              })
              .then(callback)
              .catch(errback)
          },
        )
      }

      const myPeer = {
        id: context.peerId,
        info: context.peerInfo,
        device: context.browser,
      }

      // Join now into the room.
      // NOTE: Don't send our RTP capabilities if we don't want to consume.
      let { peers } = await protoo.request('join', {
        ...myPeer,
        consuming: settings.consume,
        producing: settings.produce,
        rtpCapabilities: settings.consume
          ? mediasoupDevice.rtpCapabilities
          : undefined,
      })
      peers = [...peers, myPeer]

      return {
        peers,
        sendTransport,
        recvTransport,
        mediasoupDevice,
      }
    }
  },
  performLeave: async (context) => {
    const { protoo } = context
    context.media.forEach((x) => {
      x.consumer?.close()
      if (x.producer) {
        x.producer.close()
        protoo.request('closeProducer', {
          producerId: x.producer.id,
        })
      }
    })
    context.sendTransport?.close()
    context.recvTransport?.close()
    await context.protoo.request('Leave')
  },
}

export const roomMachine = Machine<
  RoomMachineContext,
  RoomMachineSchema,
  RoomMachineEvent
>(
  {
    id: 'Room',
    initial: 'waiting',
    on: {
      DISCONNECT: 'waiting',
      'SOCKET.CLOSED': 'waiting',
    },
    states: {
      waiting: {
        on: {
          CONNECT: 'active',
        },
      },
      active: {
        initial: 'connecting',
        invoke: {
          id: 'Socket',
          src: 'socket',
        },
        exit: 'reset',
        states: {
          connecting: {
            on: {
              'SOCKET.CONNECTED': {
                target: 'connected',
                actions: [
                  assign({
                    protoo: (context, event) =>
                      event.protoo,
                    mediasoupDevice: (context, event) =>
                      event.mediasoupDevice,
                  }),
                ],
              },
            },
          },
          connected: {
            initial: 'waiting',
            invoke: [
              {
                id: 'RequestHandler',
                src: 'requestHandler',
              },
              {
                id: 'NotificationHandler',
                src: 'notificationHandler',
              },
            ],
            on: {
              'SOCKET.DISCONNECTED': 'reconnecting',
              REQUEST: {
                // Add context instead of forwarding directly
                actions: send(
                  (context, event) => ({
                    ...event,
                    context,
                  }),
                  { to: 'RequestHandler' },
                ),
                internal: true,
              },
              NOTIFICATION: {
                // Add context instead of forwarding directly
                actions: send(
                  (context, event) => ({
                    ...event,
                    context,
                  }),
                  { to: 'NotificationHandler' },
                ),
                internal: true,
              },
              PEER_JOINED: {
                actions: assign((context, event) => ({
                  peers: [...context.peers, event.peer],
                })),
              },
              PEER_LEFT: {
                actions: assign((context, event) => ({
                  peers: context.peers.filter(
                    (x) => x.id !== event.peerId,
                  ),
                  media: context.media.filter(
                    (x) => x.peerId !== event.peerId,
                  ),
                })),
              },
              PEER_UPDATED: {
                actions: assign((context, event) => ({
                  peers: context.peers.map((x) =>
                    x.id !== event.peerId
                      ? x
                      : { ...x, info: event.info },
                  ),
                })),
              },
              LOCAL_MEDIA_ADDED: {
                actions: 'addMedia',
              },
              REMOTE_MEDIA_ADDED: {
                actions: 'addMedia',
              },
              'MEDIA.CLOSED': {
                actions: [
                  assign((context, event) => ({
                    media: context.media.filter(
                      (x) => x.id !== event.mediaId,
                    ),
                  })),
                  (context, event) => {
                    context.media
                      .filter((x) => x.id === event.mediaId)
                      .forEach((x) => x.actor.stop())
                  },
                ],
              },
            },
            states: {
              waiting: {
                on: {
                  JOIN: 'joining',
                },
              },
              joining: {
                invoke: {
                  src: 'performJoin',
                  onDone: {
                    target: 'joined',
                    actions: assign(
                      (context, event: any) => ({
                        ...event.data,
                      }),
                    ),
                  },
                  onError: {
                    target: 'waiting',
                  },
                },
              },
              joined: {
                invoke: {
                  id: 'CommandHandler',
                  src: 'commandHandler',
                },
                on: {
                  LEAVE: 'leaving',
                  COMMAND: {
                    actions: send(
                      (context, event) => ({
                        type: 'COMMAND',
                        context,
                        command: event.command,
                      }),
                      { to: 'CommandHandler' },
                    ),
                  },
                },
              },
              leaving: {
                invoke: {
                  src: 'performLeave',
                  onDone: {
                    actions: 'reset',
                    target: 'left',
                  },
                  onError: {
                    target: 'joined',
                  },
                },
              },
              left: {
                on: {
                  JOIN: 'joining',
                },
              },
            },
          },
          reconnecting: {
            on: {
              'SOCKET.CONNECTED': {
                target: 'connected',
              },
            },
          },
        },
      },
    },
  },
  {
    services: roomServices,
    actions: {
      reset: assign((context) => ({
        peers: [],
        media: [],
      })),
      addMedia: assign((context, event: any) => ({
        media: [
          ...context.media,
          {
            ...event.media,
            actor: spawn(
              mediaMachine.withContext(event.media),
              {
                sync: true,
                name: event.media.id,
              },
            ) as MediaActor,
          },
        ],
      })),
    },
  },
)
