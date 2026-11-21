/** A connection with an explicit state machine: idle -> connecting -> open -> closed, failed on error. */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

export type ConnectionEvent = 'connect' | 'opened' | 'error' | 'close' | 'retry';

export function transition(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (state) {
    case 'idle':
      return event === 'connect' ? 'connecting' : state;
    case 'connecting':
      if (event === 'opened') return 'open';
      if (event === 'error') return 'failed';
      return state;
    case 'open':
      return event === 'close' ? 'closed' : state;
    case 'failed':
      return event === 'retry' ? 'idle' : state;
    case 'closed':
      return state;
  }
}

export class Connection {
  state: ConnectionState = 'idle';

  send(event: ConnectionEvent): ConnectionState {
    this.state = transition(this.state, event);
    return this.state;
  }
}
