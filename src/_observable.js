import {just as streamOfJust} from 'most'
import {create as createStream} from '@most/create'
import {result, uniqueId} from 'lodash/fp'

export default {
  session: {
    event$: ['object', true, () => ({})],
    prop$: ['object', true, () => ({})],
  },
  waitFor (prop, ctx = this) {
    const getProp = result(prop)
    if (getProp(ctx)) {
      return Promise.resolve(getProp(ctx))
    }
    return new Promise(resolve => {
      this.listenToOnce(ctx, `change:${prop}`, () => resolve(getProp(ctx)))
    })
  },
  startStreams () {
    // Override
  },
  streamOfOneEvent (event, target) {
    target = target || this
    return createStream((add, end, error) => {
      const handle = x => {
        add(x)
        end()
      }
      this.on(event, add)

      // Dispose
      return () => {
        this.off(event, handle)
      }
    })
  },
  streamOfEvent (event, target) {
    // Converts a generic ampersand event listener into a stream of events
    target = target || this
    const id = uniqueId() + (target.name ? ` (${target.name})` : '')

    const existing = result(`${id}.${event}`)(this.event$)
    if (existing) {
      return existing
    }

    this.event$[id] = this.event$[id] || {}
    const stream = createStream((add, end, error) => {
      this.on(event, add)

      // Dispose
      return () => {
        this.off(event, add)
      }
    })
    this.event$[id][event] = stream
    return stream
  },
  streamOfProperty (property) {
    // Returns all changes to a property as a stream of events
    // Subscribers will receive a stream of the new property values
    if (!this.prop$[property]) {
      // If the property doesn't already have a stream, create a new one
      const event = `change:${property}`
      const stream = this.streamOfEvent(event)
        .map(() => this[property])

      this.prop$[property] = {
        stream,
        history: [],
      }

      if (window.isDebug) {
        stream.forEach(x => {
          const info = {
            timestamp: Date.now(),
            val: x,
          }
          this.prop$[property].history.push(info)
        })
      }
    }

    return this.prop$[property].stream
      .startWith(this[property])
      .until(this.streamOfOneEvent('remove'))
  },
  // Receive a stream of changes to a property's property
  // e.g. I want the name of my child's teacher, regardless of who the teacher is
  streamOfChildProperty (prop, childProp) {
    const child$ = this.streamOfProperty(prop)
    return child$.concatMap(x => {
      if (x) {
        return x
          .streamOfProperty(childProp)
          .startWith(result(`${prop}.${childProp}`)(this))
          .until(this.streamOfOneEvent(`change:${prop}`))
      } else {
        return streamOfJust(null)
      }
    }).until(this.streamOfOneEvent('remove'))
  },
}
