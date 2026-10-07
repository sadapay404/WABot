/**
 * Nexus-WA — media description helpers.
 *
 * Shared by the anti-delete notifier, the view-once capture and the media
 * archive so all three describe the same file the same way.
 */

const MEDIA_LABEL = {
  image: 'photo',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
};

/**
 * Voice notes and uploaded audio are both `audioMessage`; only the mimetype
 * tells them apart. Getting this wrong is the difference between "Deleted
 * voice note" and a meaningless "Deleted audio".
 */
export function describeMedia(record) {
  const kind = record?.kind;
  if (kind === 'audio') {
    const mime = record?.media_mimetype || record?.mimetype || '';
    return /ogg|opus/i.test(mime) ? 'voice note' : 'audio file';
  }
  return MEDIA_LABEL[kind] || kind || 'message';
}

/** Emoji for the dashboard and notifications. */
export function mediaIcon(kind) {
  return (
    {
      image: '📷',
      video: '🎬',
      audio: '🎤',
      document: '📄',
      sticker: '🏷️',
    }[kind] || '📎'
  );
}

export { MEDIA_LABEL };
export default { describeMedia, mediaIcon, MEDIA_LABEL };
