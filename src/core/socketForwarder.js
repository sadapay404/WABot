/**
 * A stable facade over a WhatsAppConnection's replaceable Baileys socket.
 *
 * A reconnect creates a new raw socket. Sending must reach that new socket,
 * but long-lived event consumers must stay attached to the connection-level
 * event relay rather than disappearing with the old socket.
 */
export function createLiveSocket(connection) {
  const events = {
    on(event, listener) {
      connection.on(event, listener);
      return events;
    },
  };

  return new Proxy(
    {},
    {
      get(_, prop) {
        // `wireEvents` uses socket.ev when it is present. This bridge keeps
        // handlers alive across reconnects instead of binding them to socket #1.
        if (prop === 'ev') return events;
        const live = connection.socket;
        if (!live) throw new Error('Connection Closed');
        const value = live[prop];
        return typeof value === 'function' ? value.bind(live) : value;
      },
      set(_, prop, value) {
        const live = connection.socket;
        if (live) live[prop] = value;
        return true;
      },
    }
  );
}

export default createLiveSocket;
