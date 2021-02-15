import {
  assign,
  Machine,
  sendParent,
} from 'xstate'

import {
  MediaMachineContext,
  MediaMachineEvent,
  MediaMachineSchema,
} from './index'

type EventName = keyof ElementEventMap
const useListener = <K extends EventName>(
  el: EventTarget,
  event: K,
  callback: (event: ElementEventMap[K]) => void,
) => {
  el.addEventListener(event, callback)
  return () => el.removeEventListener(event, callback)
}

// TODO: Different states for remotely paused and locally paused
export const mediaMachine = Machine<
  MediaMachineContext,
  MediaMachineSchema,
  MediaMachineEvent
>(
  {
    id: 'Media',
    initial: 'active',
    states: {
      active: {
        invoke: [
          {
            id: 'Track',
            src: 'track',
          },
          {
            id: 'Producer',
            src: 'producer',
          },
        ],
        on: {
          CLOSED: {
            target: 'stopped',
          },
          SWITCH: {
            // TODO: Make sure switching while paused behaves as expected
            target: 'switching',
          },
          'TRACK.ENDED': {
            target: 'stopped',
          },
        },
        initial: '_',
        states: {
          _: {
            always: [
              {
                target: 'paused',
                cond: 'isPaused',
              },
              {
                target: 'live',
              }
            ],
          },
          live: {
            // TODO: Initial state based on track.muted (unhealthy)
            // TODO: Gather "Unhealthy" from other diagnostic data as well
            //  with healthMonitor service
            initial: 'healthy',
            on: {
              PAUSED: {
                target: 'paused',
              },
            },
            states: {
              healthy: {
                on: {
                  'TRACK.METADATA_FAILURE': {
                    target: 'unhealthy',
                  },
                },
              },
              unhealthy: {
                on: {
                  'TRACK.METADATA_RESOLVED': {
                    target: 'healthy',
                  },
                },
              },
            },
          },
          paused: {
            on: {
              RESUMED: {
                target: 'live',
              },
            },
          },
        },
      },
      switching: {
        invoke: {
          src: 'switch',
          onDone: {
            target: 'active',
            actions: assign((context, event) => ({
              track: event.data.track,
            })),
          },
          onError: {
            target: 'stopped',
          },
        },
      },
      stopped: {
        type: 'final',
        entry: [
          'close',
          sendParent((context) => ({
            type: 'MEDIA.CLOSED',
            mediaId: context.id,
          })),
        ],
      },
    },
  },
  {
    guards: {
      isPaused: (context) =>
        context?.producer?.paused ||
        context?.consumer?.paused,
    },
    actions: {
      close: (context) => {
        context.consumer?.close()
        context.producer?.close()
      },
    },
    services: {
      switch: async (context, event: any) => {
        console.log('Switching media track', {
          previous: context.track,
          next: event.track,
        })
        await context.producer.replaceTrack({
          track: event.track,
        })
        return { track: event.track }
      },
      producer: (context) => (sendBack, onReceive) => {
        context.producer?.on('close', () =>
          sendBack({
            type: 'CLOSED',
          }),
        )
      },
      track: (context) => (sendBack, onReceive) => {
        const { track } = context

        const disposables = [
          useListener(track, 'muted' as EventName, (e) => {
            sendBack({
              type: 'TRACK.METADATA_FAILURE',
            })
          }),
          useListener(
            track,
            'unmuted' as EventName,
            (e) => {
              sendBack({
                type: 'TRACK.METADATA_RESOLVED',
              })
            },
          ),
          useListener(track, 'ended' as EventName, (e) => {
            sendBack({
              type: 'TRACK.ENDED',
            })
          }),
        ]

        return () => {
          // Clean up event listeners
          disposables.forEach((x) => x())
          // Stop the track in case it's not already
          track?.stop()
        }
      },
    },
  },
)
