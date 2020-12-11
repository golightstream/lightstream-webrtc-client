'use strict'

import State from 'ampersand-state'

const Message = State.extend({
  props: {
    id: 'string',
    peer: 'state',
    timestamp: 'number',
    type: 'string',
    name: 'string',
    text: 'string',
    uri: 'string',
    username: ['string', true, ''],
    isRemote: ['boolean', true, false],
    isAlert: ['boolean', true, false],
    data: ['object', true, () => ({})],
  },
  initialize () {
    if (this.peer) {
      this.listenToAndRun(this.peer, 'change:displayName', () => this.username = this.peer.displayName)
    }
  },
})

export default Message
