/**
 * Local media-forensics helpers.
 *
 * Every parser in this module operates on the bytes the user explicitly
 * attached/replied to. Nothing is uploaded to an AI or third-party service.
 */

import crypto from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import exifr from 'exifr';
import { parseBuffer } from 'music-metadata';
import { Jimp } from 'jimp';
import jsQR from 'jsqr';
import JSZip from 'jszip';

const MAX_ANALYSIS_BYTES = 25 * 1024 * 1024;
const MAX_RAW_FIELDS = 180;
const MAX_QR_PIXELS = 16_000_000;

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/heif': 'heic', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  'application/pdf': 'pdf', 'application/zip': 'zip',
};

const DATE_KEYS = new Set([
  'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'DateTime', 'GPSDateStamp',
  'MediaCreateDate', 'MediaModifyDate', 'TrackCreateDate', 'TrackModifyDate',
  'FileModifyDate', 'CreationDate', 'ModDate', 'created', 'modified',
]);

export function bytesLabel(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let index = 0;
  while (n >= 1024 && index < units.length - 1) { n /= 1024; index++; }
  return `${n.toFixed(n >= 10 ? 1 : 2)} ${units[index]}`;
}

function number(value, fallback = null) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function safeString(value, max = 220) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary ${value.length} bytes]`;
  const text = Array.isArray(value) ? value.map((item) => safeString(item, 80) || '').join(', ') : String(value);
  return text.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) || null;
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const text = safeString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function sanitizeFilename(value) {
  return String(value || '').replace(/[\\/\0\r\n]/g, '_').slice(0, 120) || null;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function isImage(mime) { return /^image\//i.test(String(mime || '')); }
function isAudioOrVideo(mime, kind) {
  return /^(audio|video)\//i.test(String(mime || '')) || kind === 'audio' || kind === 'video';
}

function extensionFromMime(mime) {
  return MIME_EXTENSIONS[String(mime || '').toLowerCase()] || null;
}

export async function detectFile(buffer, declaredMime = null) {
  let detected = null;
  try { detected = await fileTypeFromBuffer(buffer); } catch { /* unknown signature */ }
  const mime = detected?.mime || declaredMime || 'application/octet-stream';
  return { mime, ext: detected?.ext || extensionFromMime(mime) || 'bin', detected: Boolean(detected) };
}

function normalizeExif(raw = {}) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (/thumbnail/i.test(key)) continue;
    const printable = safeString(value);
    if (printable) out[key] = printable;
  }
  return out;
}

async function imageDetails(buffer) {
  let raw = {};
  try {
    raw = await exifr.parse(buffer, {
      tiff: true, ifd0: true, exif: true, gps: true, interop: true,
      xmp: true, iptc: true, icc: true, jfif: true, ihdr: true,
      makerNote: true, userComment: true, mergeOutput: true,
      translateKeys: true, translateValues: true, reviveValues: true,
      silentErrors: true,
    }) || {};
  } catch { raw = {}; }

  let dimensions = {
    width: number(first(raw.ExifImageWidth, raw.ImageWidth, raw.PixelXDimension)),
    height: number(first(raw.ExifImageHeight, raw.ImageHeight, raw.PixelYDimension)),
  };
  // Exifr reads metadata, but a normal WhatsApp-recompressed image often has
  // no EXIF. Decoding gives dimensions even in that case.
  if (!dimensions.width || !dimensions.height) {
    try {
      const image = await Jimp.read(buffer);
      dimensions = { width: image.bitmap.width, height: image.bitmap.height };
    } catch { /* unsupported image decoder */ }
  }

  const latitude = number(first(raw.latitude, raw.GPSLatitude));
  const longitude = number(first(raw.longitude, raw.GPSLongitude));
  const make = safeString(first(raw.Make, raw.CameraMake));
  const model = safeString(first(raw.Model, raw.CameraModel));
  const software = safeString(first(raw.Software, raw.ProcessingSoftware));
  const capturedAt = isoDate(first(raw.DateTimeOriginal, raw.CreateDate, raw.DateTime));
  return {
    raw: normalizeExif(raw), dimensions, latitude, longitude, make, model, software, capturedAt,
    lens: safeString(first(raw.LensModel, raw.LensMake)), aperture: safeString(raw.FNumber),
    iso: safeString(raw.ISO), exposure: safeString(raw.ExposureTime), focalLength: safeString(raw.FocalLength),
    orientation: safeString(raw.Orientation),
  };
}

function primitiveTags(common = {}) {
  const wanted = ['title', 'artist', 'album', 'albumartist', 'year', 'date', 'genre', 'composer', 'comment', 'copyright', 'encoder', 'bpm'];
  const tags = {};
  for (const key of wanted) {
    const value = safeString(common[key]);
    if (value) tags[key] = value;
  }
  return tags;
}

async function avDetails(buffer, mime) {
  try {
    const parsed = await parseBuffer(buffer, { mimeType: mime, size: buffer.length }, { duration: true, skipCovers: true });
    const format = parsed.format || {};
    const tracks = (format.trackInfo || []).map((track) => ({
      type: track.type,
      codec: track.codec,
      duration: number(track.duration),
      bitrate: number(track.bitrate),
      width: number(track.video?.pixelWidth),
      height: number(track.video?.pixelHeight),
      frameRate: number(track.video?.frameRate),
      sampleRate: number(track.audio?.sampleRate || track.sampleRate),
      channels: number(track.audio?.numberOfChannels || track.numberOfChannels),
    }));
    return {
      container: safeString(format.container), codec: safeString(format.codec), codecProfile: safeString(format.codecProfile),
      duration: number(first(format.containerDuration, format.duration)), bitrate: number(first(format.overallBitrate, format.bitrate)),
      sampleRate: number(format.sampleRate), channels: number(format.numberOfChannels), bitsPerSample: number(format.bitsPerSample),
      lossless: typeof format.lossless === 'boolean' ? format.lossless : null,
      tagTypes: Array.isArray(format.tagTypes) ? format.tagTypes.map(String) : [], tracks,
      tags: primitiveTags(parsed.common), raw: Object.fromEntries(Object.entries(parsed.common || {}).filter(([, value]) => safeString(value)).slice(0, MAX_RAW_FIELDS).map(([key, value]) => [key, safeString(value)])),
    };
  } catch (err) {
    return { parseError: safeString(err?.message, 120), tags: {}, tracks: [], raw: {} };
  }
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function xmlTag(xml, tag) {
  const found = String(xml || '').match(new RegExp(`<[^>]*${tag}[^>]*>([\\s\\S]*?)<\\/[^>]*${tag}>`, 'i'));
  return found ? decodeXml(found[1]) || null : null;
}

function pdfDetails(buffer) {
  // PDF info dictionaries and XMP can be compressed, so this is an honest
  // best-effort reader rather than a claim that invisible fields were decoded.
  const text = buffer.subarray(0, Math.min(buffer.length, 3 * 1024 * 1024)).toString('latin1');
  const pick = (key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const literal = text.match(new RegExp(`/${escaped}\\s*\\(([^)]{1,400})\\)`, 'i'))?.[1];
    const atom = text.match(new RegExp(`/${escaped}\\s*/?([^\\s<>[\\]()]{1,200})`, 'i'))?.[1];
    return safeString(literal || atom);
  };
  const urls = [...text.matchAll(/\bhttps?:\/\/[^\s<>()"']{1,300}/gi)].map((m) => m[0]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);
  return {
    type: 'pdf', title: pick('Title'), author: pick('Author'), creator: pick('Creator'), producer: pick('Producer'),
    creationDate: pick('CreationDate'), modifiedDate: pick('ModDate'), urls,
    embeddedFiles: /\/EmbeddedFiles\b/i.test(text), javascript: /\/(JavaScript|JS)\b/i.test(text),
    encrypted: /\/Encrypt\b/i.test(text),
  };
}

async function officeDetails(buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
    const names = Object.keys(zip.files);
    const isOffice = names.some((name) => /^\[Content_Types\]\.xml$/i.test(name)) && names.some((name) => /^docProps\//i.test(name));
    if (!isOffice) return { type: 'zip', entries: names.length };
    const get = async (name) => zip.file(name) ? zip.file(name).async('string') : '';
    const core = await get('docProps/core.xml');
    const app = await get('docProps/app.xml');
    const relations = await Promise.all(names.filter((name) => /\.rels$/i.test(name)).slice(0, 25).map(get));
    const links = relations
      .flatMap((xml) => [...String(xml).matchAll(/Target="(https?:[^"\s]+)"/gi)].map((m) => decodeXml(m[1])))
      .filter((value, index, list) => value && list.indexOf(value) === index).slice(0, 20);
    return {
      type: names.some((name) => /^word\//.test(name)) ? 'Office Word document' : names.some((name) => /^xl\//.test(name)) ? 'Office spreadsheet' : names.some((name) => /^ppt\//.test(name)) ? 'Office presentation' : 'Office document',
      author: xmlTag(core, 'creator'), lastModifiedBy: xmlTag(core, 'lastModifiedBy'),
      created: xmlTag(core, 'created'), modified: xmlTag(core, 'modified'),
      application: xmlTag(app, 'Application'), pages: xmlTag(app, 'Pages'),
      macros: names.some((name) => /vbaProject\.bin$/i.test(name)), externalLinks: links,
      embeddedFiles: names.filter((name) => /embeddings\//i.test(name)).length, entries: names.length,
    };
  } catch (err) {
    return { type: 'zip', parseError: safeString(err?.message, 120) };
  }
}

async function documentDetails(buffer, mime, ext) {
  if (mime === 'application/pdf' || ext === 'pdf' || buffer.subarray(0, 5).toString() === '%PDF-') return pdfDetails(buffer);
  const isZip = mime === 'application/zip' || /zip|officedocument|msword|spreadsheet|presentation/i.test(mime) || buffer.subarray(0, 4).toString() === 'PK\x03\x04';
  return isZip ? officeDetails(buffer) : null;
}

function dateEntries(raw = {}, document = null, media = null) {
  const entries = [];
  for (const [key, value] of Object.entries(raw || {})) {
    if (!DATE_KEYS.has(key) && !/(date|time|created|modified)/i.test(key)) continue;
    const formatted = isoDate(value);
    if (formatted) entries.push({ source: key, value: formatted });
  }
  for (const [source, value] of Object.entries({
    'Document created': document?.created || document?.creationDate,
    'Document modified': document?.modified || document?.modifiedDate,
    'Media date': media?.tags?.date,
    'Media year': media?.tags?.year,
  })) {
    const formatted = isoDate(value);
    if (formatted) entries.push({ source, value: formatted });
  }
  const unique = new Map();
  for (const entry of entries) if (!unique.has(`${entry.source}:${entry.value}`)) unique.set(`${entry.source}:${entry.value}`, entry);
  return [...unique.values()].slice(0, 30);
}

export async function inspectMedia(buffer, { media = {}, stanzaId = '' } = {}) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  if (buffer.length > MAX_ANALYSIS_BYTES) {
    throw new Error(`this file is ${bytesLabel(buffer.length)}; forensic analysis is limited to ${bytesLabel(MAX_ANALYSIS_BYTES)} per command`);
  }
  const declaredMime = media.mimetype || null;
  const detected = await detectFile(buffer, declaredMime);
  const mime = detected.mime;
  const fileName = sanitizeFilename(media?.payload?.fileName);
  const nameExt = fileName?.split('.').pop()?.toLowerCase() || null;
  const extensionMismatch = Boolean(nameExt && detected.ext && nameExt !== detected.ext && !(nameExt === 'jpeg' && detected.ext === 'jpg'));
  const image = isImage(mime) ? await imageDetails(buffer) : null;
  const av = isAudioOrVideo(mime, media.type) ? await avDetails(buffer, mime) : null;
  const document = !image && !av ? await documentDetails(buffer, mime, detected.ext) : null;
  const raw = { ...(image?.raw || {}), ...(av?.raw || {}) };
  const timeline = dateEntries(raw, document, av);
  return {
    stanzaId, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    declaredMime, fileName, nameExt, extensionMismatch, detected,
    image, av, document, timeline, raw,
  };
}

export async function perceptualHash(buffer) {
  const image = await Jimp.read(buffer);
  if (image.bitmap.width * image.bitmap.height > MAX_QR_PIXELS) throw new Error('image is too large to fingerprint safely');
  image.resize({ w: 9, h: 8 }).greyscale();
  const { data, width } = image.bitmap;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[(y * width + x) * 4];
      const right = data[(y * width + x + 1) * 4];
      bits += left > right ? '1' : '0';
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function hammingDistanceHex(a, b) {
  if (!/^[0-9a-f]{16}$/i.test(String(a)) || !/^[0-9a-f]{16}$/i.test(String(b))) return null;
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

export async function decodeQr(buffer) {
  const image = await Jimp.read(buffer);
  if (image.bitmap.width * image.bitmap.height > MAX_QR_PIXELS) throw new Error('image is too large to scan safely');
  const code = jsQR(image.bitmap.data, image.bitmap.width, image.bitmap.height, { inversionAttempts: 'attemptBoth' });
  return code?.data || null;
}

/** Remove common EXIF/XMP/IPTC metadata blocks while preserving image pixels. */
export async function cleanImageMetadata(buffer, mime) {
  const kind = (await detectFile(buffer, mime)).mime;
  if (kind === 'image/jpeg') return cleanJpeg(buffer);
  if (kind === 'image/png') return cleanPng(buffer);
  if (kind === 'image/webp') return cleanWebp(buffer);
  throw new Error('cleaning currently supports JPEG, PNG, and WebP images only');
}

function cleanJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('not a valid JPEG');
  const parts = [buffer.subarray(0, 2)];
  let pos = 2;
  while (pos < buffer.length) {
    if (buffer[pos] !== 0xff) { parts.push(buffer.subarray(pos)); break; }
    let markerEnd = pos + 1;
    while (markerEnd < buffer.length && buffer[markerEnd] === 0xff) markerEnd++;
    const marker = buffer[markerEnd];
    if (marker === 0xda || marker === 0xd9) { parts.push(buffer.subarray(pos)); break; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { parts.push(buffer.subarray(pos, markerEnd + 1)); pos = markerEnd + 1; continue; }
    const length = buffer.readUInt16BE(markerEnd + 1);
    const end = markerEnd + 1 + length;
    if (length < 2 || end > buffer.length) throw new Error('malformed JPEG segment');
    // APP1 EXIF/XMP, APP2 ICC profiles, APP13 IPTC and COM may disclose data.
    if (![0xe1, 0xe2, 0xed, 0xfe].includes(marker)) parts.push(buffer.subarray(pos, end));
    pos = end;
  }
  return Buffer.concat(parts);
}

function cleanPng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('not a valid PNG');
  const parts = [signature];
  let pos = 8;
  while (pos + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const end = pos + 12 + length;
    if (end > buffer.length) throw new Error('malformed PNG chunk');
    const type = buffer.subarray(pos + 4, pos + 8).toString('ascii');
    if (!['eXIf', 'iTXt', 'tEXt', 'zTXt', 'iCCP'].includes(type)) parts.push(buffer.subarray(pos, end));
    pos = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

function cleanWebp(buffer) {
  if (buffer.subarray(0, 4).toString() !== 'RIFF' || buffer.subarray(8, 12).toString() !== 'WEBP') throw new Error('not a valid WebP');
  const parts = [buffer.subarray(0, 12)];
  let pos = 12;
  while (pos + 8 <= buffer.length) {
    const type = buffer.subarray(pos, pos + 4).toString('ascii');
    const length = buffer.readUInt32LE(pos + 4);
    const padded = length + (length % 2);
    const end = pos + 8 + padded;
    if (end > buffer.length) throw new Error('malformed WebP chunk');
    if (!['EXIF', 'XMP ', 'ICCP'].includes(type)) parts.push(buffer.subarray(pos, end));
    pos = end;
  }
  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

function line(label, value) { return value ? `${label}: ${value}` : null; }
function durationLabel(seconds) { return Number.isFinite(seconds) ? `${seconds.toFixed(seconds >= 60 ? 0 : 1)} sec` : null; }
function bitrateLabel(value) { return Number.isFinite(value) ? `${Math.round(value / 1000)} kbps` : null; }

export function metadataSummary(report) {
  const lines = [
    '🧬 *MEDIA X-RAY*', '',
    `File: ${report.fileName || 'unnamed media'}`,
    `Actual type: ${report.detected.mime}${report.detected.ext ? ` (.${report.detected.ext})` : ''}`,
    `Size: ${bytesLabel(report.bytes)}`,
    `SHA-256: ${report.sha256}`,
  ];
  if (report.extensionMismatch) lines.push(`⚠️ Filename extension .${report.nameExt} does not match detected .${report.detected.ext}.`);
  if (report.image) {
    const image = report.image;
    lines.push('', '📷 *Image details*');
    if (image.dimensions.width && image.dimensions.height) lines.push(`Dimensions: ${image.dimensions.width} × ${image.dimensions.height}`);
    const camera = [image.make, image.model].filter(Boolean).join(' ');
    if (camera) lines.push(`Camera: ${camera}`);
    for (const item of [line('Lens', image.lens), line('Aperture', image.aperture), line('ISO', image.iso), line('Exposure', image.exposure), line('Focal length', image.focalLength), line('Taken', image.capturedAt), line('Software', image.software)]) if (item) lines.push(item);
    if (image.latitude != null && image.longitude != null) {
      lines.push('', '📍 *Embedded GPS*', `${image.latitude.toFixed(6)}, ${image.longitude.toFixed(6)}`, `Map: https://www.google.com/maps/search/?api=1&query=${image.latitude},${image.longitude}`);
    } else lines.push('GPS: none found in this file');
  }
  if (report.av) {
    const av = report.av;
    lines.push('', '🎞️ *Media details*');
    for (const item of [line('Container', av.container), line('Codec', av.codec), line('Duration', durationLabel(av.duration)), line('Bitrate', bitrateLabel(av.bitrate)), line('Sample rate', av.sampleRate ? `${av.sampleRate} Hz` : null), line('Channels', av.channels), line('Tag formats', av.tagTypes?.join(', '))]) if (item) lines.push(item);
    for (const track of av.tracks || []) {
      const description = [track.type, track.codec, track.width && track.height ? `${track.width}×${track.height}` : null, track.frameRate ? `${track.frameRate} FPS` : null].filter(Boolean).join(' · ');
      if (description) lines.push(`Track: ${description}`);
    }
    for (const [key, value] of Object.entries(av.tags || {})) lines.push(`${key}: ${value}`);
    if (av.parseError) lines.push(`Parser note: ${av.parseError}`);
  }
  if (report.document) lines.push('', ...documentSummaryLines(report.document));
  lines.push('', `_This report shows metadata still embedded in the shared file; it cannot recover data WhatsApp already removed._`);
  return lines.join('\n');
}

export function documentSummaryLines(document) {
  const lines = ['📄 *Document X-RAY*', `Type: ${document.type || 'document'}`];
  for (const item of [line('Title', document.title), line('Author', document.author), line('Last editor', document.lastModifiedBy), line('Created', document.created || document.creationDate), line('Modified', document.modified || document.modifiedDate), line('Application', document.application), line('Producer', document.producer), line('Creator', document.creator), line('Pages', document.pages), line('Archive entries', document.entries)]) if (item) lines.push(item);
  if (document.externalLinks?.length) lines.push(`External links: ${document.externalLinks.join(', ')}`);
  if (document.urls?.length) lines.push(`URLs: ${document.urls.join(', ')}`);
  if (document.embeddedFiles) lines.push(`Embedded files: ${document.embeddedFiles === true ? 'present' : document.embeddedFiles}`);
  if (document.macros) lines.push('⚠️ Macros: present');
  if (document.javascript) lines.push('⚠️ PDF JavaScript: present');
  if (document.encrypted) lines.push('🔒 PDF encryption marker: present');
  if (document.parseError) lines.push(`Parser note: ${document.parseError}`);
  return lines;
}

export function timelineSummary(report) {
  const lines = ['🕒 *MEDIA TIMELINE*', ''];
  if (!report.timeline.length) return `${lines.join('\n')}No embedded capture, creation, or modification timestamps were readable in this file.`;
  for (const entry of report.timeline) lines.push(`• ${entry.source}: ${entry.value}`);
  lines.push('', '_Different timestamps can result from copying or editing. They are clues, not proof of deception._');
  return lines.join('\n');
}

export function rawMetadataText(report) {
  const raw = Object.entries(report.raw || {}).slice(0, MAX_RAW_FIELDS);
  const header = [
    'Nexus-WA MEDIA X-RAY — raw readable metadata',
    `SHA-256: ${report.sha256}`,
    `Detected type: ${report.detected.mime}`,
    '',
  ];
  const body = raw.length ? raw.map(([key, value]) => `${key}: ${value}`) : ['No readable EXIF/XMP/IPTC/audio tag fields were found.'];
  return [...header, ...body].join('\n');
}
