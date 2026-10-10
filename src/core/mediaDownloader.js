/** Download media from an inbound Baileys message as a Buffer. */
export async function downloadWhatsAppMedia(socket, rawMessage, logger = null, packageDownloader = null) {
  if (typeof socket?.downloadMediaMessage === 'function') {
    // The preview/test transport exposes the same helper for deterministic
    // marker bytes. Some other adapters may also provide this convenience.
    return socket.downloadMediaMessage(rawMessage);
  }

  // In current Baileys releases this is a package utility, not a socket method.
  const downloadMediaMessage = packageDownloader ||
    (await import('@whiskeysockets/baileys')).downloadMediaMessage;
  const context = logger ? { logger } : {};
  if (typeof socket?.updateMediaMessage === 'function') {
    context.reuploadRequest = (message) => socket.updateMediaMessage(message);
  }
  return downloadMediaMessage(rawMessage, 'buffer', {}, context);
}

export default downloadWhatsAppMedia;
