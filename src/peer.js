'use strict'

import State from 'ampersand-state'
import Collection from 'ampersand-rest-collection'
import Observable from './_observable'
import {is, pipe, whereEq, keys} from 'ramda'
import {create as createStream} from '@most/create'

const Peer = State.extend(Observable).extend({
  props: {
    id: 'any',
    displayName: 'string',
    isLocal: ['boolean', true, false],
    isHost: ['boolean', true, false],
    isWebcamLive: ['boolean', true, false],
    isScreenLive: ['boolean', true, false],
    isUser: ['boolean', true, false], // Is this a human peer or an external service feed?
    isVisible: ['boolean', true, false],
    userWebcamId: 'string', // The deviceId intended to be shared with other greenroom guests
    userMicrophoneId: 'string', // The deviceId intended to be shared with other greenroom guests
  },
  initialize (options = {}) {

  },
})

let id = 0
const uniqueId = () => {
  return ++id
}

const PeerCollection = Collection.extend(Observable).extend({
  model: Peer,
  event$: {},
  prop$: {},
  initialize () {
    this.on('add remove reset', () => this.trigger('change'))
  },
  scan (watchAttrs = [], reducer = () => {}) {
    if (is(String, watchAttrs)) {
      watchAttrs = [watchAttrs]
    }
    return createStream(addToStream => {
      const scanId = uniqueId()
      const completeEvent = `scan:complete:${scanId}`
      const complete$ = this.streamOfOneEvent(completeEvent)
      const reduce = () => pipe(
        reducer,
        addToStream
      )(this.models)

      const handleNewItem = item => watchAttrs.forEach(key =>
        item
          .streamOfProperty(key)
          .until(complete$)
          .skip(1)
          .forEach(reduce))

      this.streamOfEvent('add').until(complete$).forEach(pipe(
        handleNewItem,
        reduce
      ))
      this.streamOfEvent('remove').until(complete$).forEach(reduce)
      this.streamOfEvent('reset').until(complete$).forEach(reduce)
      this.each(handleNewItem)
      reduce()

      // Dispose
      return () => {
        this.trigger(completeEvent)
      }
    })
  },
})

PeerCollection.prototype.filtered = function (matchAttrs = {}) {
  const matchKeys = keys(matchAttrs)
  const collection = new PeerCollection()
  const checkMatch = whereEq(matchAttrs)
  const updateItem = item => checkMatch(item) ? collection.add(item) : collection.remove(item)
  const handleNewItem = item => {
    matchKeys.forEach(key => item.on(`change:${key}`, () => updateItem(item)))
    updateItem(item)
  }

  this.each(handleNewItem)
  this.on('add', handleNewItem)
  this.on('remove', item => collection.remove(item))
  this.on('reset', () => collection.reset())

  return collection
}

export {Peer, PeerCollection}
