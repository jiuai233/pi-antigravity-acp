import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Reserve 256 bytes under AGY's 10,240-byte inline cap for its Created/Completed wrapper lines.
export const MAX_BRIDGE_OUTPUT_BYTES = 9_984;
const BRIDGE_LINE_SNAP_BYTES = 512;
const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

const MAX_ARCHIVE_DIR_BYTES = 1_024;

function storeArchive(text: string, kind: "history" | "requests" | "tool-output", directory?: string): string {
  let target = directory ? path.join(directory, kind) : path.join(os.tmpdir(), `pi-antigravity-${kind}`);
  if (utf8Bytes(target) > MAX_ARCHIVE_DIR_BYTES) {
    const localTemp = path.join(process.env.LOCALAPPDATA || os.homedir(), "Temp", `pi-antigravity-${kind}`);
    target = utf8Bytes(localTemp) <= MAX_ARCHIVE_DIR_BYTES
      ? localTemp
      : path.join(os.homedir(), ".gemini", "antigravity-cli", `pi-antigravity-${kind}`);
  }
  mkdirSync(target, { recursive: true });
  const file = path.resolve(target, `${randomUUID()}.txt`);
  writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  return file;
}

const isContinuationByte = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xc0) === 0x80;

function countNewlines(bytes: Buffer, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index++) if (bytes[index] === 0x0a) count++;
  return count;
}

/**
 * agy replaces any MCP tool output over 10,240 UTF-8 bytes with a bare
 * `The output was large and was saved to: file:///.../output.txt` pointer,
 * hiding both the beginning and the trailing summary/error. Keep the head and
 * tail inline within the 10 KiB budget and archive the full output for
 * read_file when native file reading is available.
 */
export function fitBridgeToolOutput(
  text: string,
  options: { readable?: boolean; directory?: string; maxBytes?: number } = {},
): string {
  const maxBytes = Math.max(1_024, options.maxBytes ?? MAX_BRIDGE_OUTPUT_BYTES);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const readable = options.readable !== false;
  let file = readable ? JSON.stringify(storeArchive(text, "tool-output", options.directory)) : undefined;
  const totalLines = countNewlines(bytes, bytes.length) + 1;
  const maxRange = `lines ${totalLines}-${totalLines}`;
  const buildNotice = (rangeText: string, fileRef: string | undefined): string =>
    fileRef
      ? `[Tool output too long for inline MCP delivery (${bytes.length} bytes): ${rangeText} are omitted below. Full output: ${fileRef}. Use the enabled native read_file tool with Path=${fileRef} to read the full UTF-8 output (or the MCP read tool if control bytes trigger a binary-file error).]`
      : `[Tool output too long for inline MCP delivery (${bytes.length} bytes): the beginning and end are kept and ${rangeText} are omitted.]`;
  const maxMiddle = `[... ${maxRange} omitted (${bytes.length} bytes) ...]`;
  let overhead = utf8Bytes(buildNotice(maxRange, file)) + utf8Bytes(maxMiddle) + 6;
  if (file && overhead + 64 > maxBytes) {
    file = undefined;
    overhead = utf8Bytes(buildNotice(maxRange, undefined)) + utf8Bytes(maxMiddle) + 6;
  }
  const keep = Math.max(64, maxBytes - overhead);
  let headEnd = Math.floor(keep / 2);
  while (headEnd > 0 && isContinuationByte(bytes[headEnd])) headEnd--;
  const newlineBefore = bytes.lastIndexOf(0x0a, headEnd);
  if (newlineBefore > 0 && headEnd - newlineBefore <= BRIDGE_LINE_SNAP_BYTES) headEnd = newlineBefore;
  let tailStart = bytes.length - (keep - headEnd);
  while (tailStart < bytes.length && isContinuationByte(bytes[tailStart])) tailStart++;
  const newlineAfter = bytes.indexOf(0x0a, tailStart - 1);
  if (
    newlineAfter >= 0 &&
    newlineAfter + 1 < bytes.length &&
    newlineAfter + 1 - tailStart <= BRIDGE_LINE_SNAP_BYTES
  ) {
    tailStart = newlineAfter + 1;
  }
  const from = countNewlines(bytes, headEnd) + (bytes[headEnd] === 0x0a ? 2 : 1);
  const tailNewlines = countNewlines(bytes, tailStart);
  const to = bytes[tailStart - 1] === 0x0a ? tailNewlines : tailNewlines + 1;
  const range = `lines ${from}-${to}`;
  const notice = buildNotice(range, file);
  const head = bytes.subarray(0, headEnd).toString("utf8");
  const tail = bytes.subarray(tailStart).toString("utf8");
  return `${notice}\n\n${head}\n\n[... ${range} omitted (${tailStart - headEnd} bytes) ...]\n\n${tail}`;
}
