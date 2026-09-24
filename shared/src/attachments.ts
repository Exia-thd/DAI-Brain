/**
 * Files the user attaches to one turn.
 *
 * They travel as base64 inside the existing JSON body rather than as multipart.
 * A chat window attaches a log, a config or a screenshot -- kilobytes, not
 * gigabytes -- and a size cap is a better answer to the large-file case than a
 * streaming upload path nobody would use. The cap is enforced here, on the
 * decoded length, because base64 is a third larger than what it encodes and a
 * limit checked against the encoded string is a limit set a third too high.
 */

import { HttpError } from './http.js';

export interface ChatAttachment {
  name: string;
  /** The file's bytes, base64. */
  data: string;
  /** The browser's guess at the media type. Advisory: never trusted. */
  type?: string;
}

/** One attachment, named and sized, ready to be written to disk. */
export interface DecodedAttachment {
  /** Safe to join to a directory: no separators, no dots-only, never empty. */
  name: string;
  bytes: Uint8Array;
  type: string;
}

export interface AttachmentLimits {
  maxCount: number;
  /** Total decoded bytes across every attachment on one turn. */
  maxTotalBytes: number;
}

const CONTROL_OR_SEPARATOR = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

/**
 * Turns a name the browser supplied into one that can only name a file.
 *
 * The name is attacker-controlled in the sense that matters: it arrives in a
 * request body, and it is about to be joined to a directory path. Everything
 * that could make it mean a *place* rather than a *file* is removed -- both
 * separators, the Windows-reserved punctuation, control characters, and any
 * leading dots, which is what turns `..` into a parent directory and `.bashrc`
 * into something that hides. What survives is at most 100 characters so a long
 * name cannot push the path past what the filesystem accepts.
 */
export function safeAttachmentName(raw: unknown, index: number): string {
  const fallback = `file-${index + 1}`;
  if (typeof raw !== 'string') return fallback;

  const cleaned = raw
    .normalize('NFC')
    .replace(CONTROL_OR_SEPARATOR, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();

  if (cleaned.length === 0) return fallback;
  if (cleaned.length <= 100) return cleaned;

  // Truncate the stem, not the extension: `.png` is what tells the reader
  // whether this is an image, and it is the end of the string.
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 100 - ext.length) + ext;
}

/** Decodes base64 without assuming Buffer, so this stays runtime-agnostic. */
function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new HttpError(400, 'bad_request', 'an attachment was not valid base64');
  }
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Validates and decodes what arrived, or refuses it as a 400.
 *
 * Refusing is an outcome here, not an exception: a file too large is something
 * the person did, and they need to be told which limit they hit, not handed a
 * 500 that reads like the server broke.
 */
export function parseAttachments(value: unknown, limits: AttachmentLimits): DecodedAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'bad_request', 'attachments must be an array');
  }
  if (value.length > limits.maxCount) {
    throw new HttpError(
      400, 'bad_request',
      `${value.length} attachments is more than the ${limits.maxCount} allowed on one message`,
    );
  }

  const out: DecodedAttachment[] = [];
  const used = new Set<string>();
  let total = 0;

  value.forEach((raw, index) => {
    const item = (raw ?? {}) as ChatAttachment;
    if (typeof item.data !== 'string') {
      throw new HttpError(400, 'bad_request', `attachment ${index + 1} has no data`);
    }
    const bytes = decodeBase64(item.data);
    total += bytes.length;
    if (total > limits.maxTotalBytes) {
      throw new HttpError(
        400, 'bad_request',
        `the attachments total more than ${Math.round(limits.maxTotalBytes / 1024)} KB, `
        + 'which is the limit for one message',
      );
    }

    // Two files of the same name on one turn would otherwise be one file, and
    // the answer would silently be about whichever was written last.
    let name = safeAttachmentName(item.name, index);
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n += 1;
      name = `${stem}-${n}${ext}`;
    }
    used.add(name);

    out.push({
      name,
      bytes,
      type: typeof item.type === 'string' && item.type.length < 100 ? item.type : 'application/octet-stream',
    });
  });

  return out;
}

/** `12.3 KB`, for a line a person reads rather than a machine parses. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
