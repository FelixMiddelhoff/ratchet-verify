import { gunzipSync } from "node:zlib";

/** Limits for the (untrusted) npm tarball. Nothing is written to disk or executed. */
export const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
export const MAX_CHANGELOG_BYTES = 1024 * 1024;

const CHANGELOG_NAME = /^(?:changelog|history|changes|news|releases?)(?:\.(?:md|markdown|txt))?$/i;

/**
 * Returns changelog-like files at the package root ("package/CHANGELOG.md") of a .tgz.
 * Only regular-file entries are read; entries with "..", absolute paths, or nested
 * directories are ignored. Returns undefined when the archive is unreadable or over the caps.
 */
export function extractChangelogFiles(tgz: Uint8Array): { name: string; text: string }[] | undefined {
  if (tgz.byteLength > MAX_TARBALL_BYTES) return undefined;
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch {
    return undefined;
  }
  const files: { name: string; text: string }[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    if (!Number.isFinite(size) || size < 0) return files;
    const start = offset + 512;
    const full = prefix ? `${prefix}/${name}` : name;
    if ((type === "0" || type === "\0") && size <= MAX_CHANGELOG_BYTES && start + size <= tar.length) {
      const base = rootFileName(full);
      if (base && CHANGELOG_NAME.test(base)) files.push({ name: base, text: tar.subarray(start, start + size).toString("utf8") });
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function field(buf: Buffer, from: number, length: number): string {
  const slice = buf.subarray(from, from + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf8");
}

/** "package/CHANGELOG.md" -> "CHANGELOG.md"; anything unsafe or nested -> undefined. */
function rootFileName(path: string): string | undefined {
  if (path.includes("\\") || path.startsWith("/")) return undefined;
  const parts = path.split("/");
  if (parts.length !== 2 || parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  return parts[1];
}
