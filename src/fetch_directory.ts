import * as stackParser from "error-stack-parser";
import { formatBytes } from "./util";
import { progressCallback } from "./worker";

export function get_file_len(url: string, chunkSize: number): number {
  const file = getFile(url, chunkSize);
  // console.log("GETLEN", url, formatBytes(file.length));
  return file.length;
}
export const files = new Map<string, LazyUint8Array>();
function getFile(url: string, chunkSize: number): LazyUint8Array {
  let file = files.get(url);
  if (!file) {
    file = new LazyUint8Array({
      rangeMapper(fromByte, toByte) {
        return { url, fromByte, toByte };
      },
      requestChunkSize: chunkSize,
      logPageReads: true,
      cacheRequestedChunk: false
    });
    files.set(url, file);
  }
  return file;
}
function basename(url: string) {
  return url.split("/").slice(-1)[0]
}
export function read_bytes_from_file(
  url: string,
  chunkSize: number,
  start: number,
  end: number,
  prefetchHint: number,
  out: Uint8Array
): void {
  const file = getFile(url, chunkSize);
  /*if (end - start > 1000)
    console.log(
      "READ",
      basename(url),
      "@" + formatBytes(start),
      "len",
      formatBytes(end - start),
      "p", formatBytes(prefetchHint)
    );*/
  file.copyInto(out, 0, end - start, start, prefetchHint);
}

export type RangeMapper = (
  fromByte: number,
  toByte: number
) => { url: string; fromByte: number; toByte: number };

export type LazyFileConfig = {
  /** function to map a read request to an url with read request  */
  rangeMapper: RangeMapper;
  /** must be known beforehand if there's multiple server chunks (i.e. rangeMapper returns different urls) */
  fileLength?: number;
  /** chunk size for random access requests (should be same as sqlite page size) */
  requestChunkSize: number;
  /** number of virtual read heads. default: 3 */
  maxReadHeads?: number;
  /** max read speed for sequential access. default: 5 MiB */
  maxReadSpeed?: number;
  /** if true, log all read pages into the `readPages` field for debugging */
  logPageReads?: boolean;
  /** if false, only cache read ahead chunks. default true, only set to false if you have your own cache */
  cacheRequestedChunk?: boolean;
};
export type PageReadLog = {
  pageno: number;
  // if page was already loaded
  wasCached: boolean;
  // how many pages were prefetched
  prefetch: number;
  reason: string;
};

type ReadHead = { startChunk: number; speed: number };

function getInterestingStack() {
  const stack = stackParser.parse(new Error());
  return stack
    .filter((s) => s.fileName?.includes(".wasm"))
    .map((s) => s.functionName)
    .filter(
      (fname) =>
        fname?.includes("tantivy::") && !fname.includes("tantivy::directory")
    )
    .slice(0, 30)
    .join("\n");
}
class LazyUint8Array {
  private serverChecked = false;
  private readonly chunks: Uint8Array[] = []; // Loaded chunks. Index is the chunk number
  totalFetchedBytes = 0;
  totalRequests = 0;
  readPages: PageReadLog[] = [];
  private _length?: number;

  // LRU list of read heds, max length = maxReadHeads. first is most recently used
  private readonly readHeads: ReadHead[] = [];
  private readonly _chunkSize: number;
  private readonly rangeMapper: RangeMapper;
  private readonly maxSpeed: number;
  private readonly maxReadHeads: number;
  private readonly logPageReads: boolean;
  private readonly cacheRequestedChunk: boolean;

  constructor(config: LazyFileConfig) {
    this._chunkSize = config.requestChunkSize;
    this.maxSpeed = Math.round(
      (config.maxReadSpeed || 5 * 1024 * 1024) / this._chunkSize
    ); // max 5MiB at once
    this.maxReadHeads = config.maxReadHeads ?? 3;
    this.rangeMapper = config.rangeMapper;
    this.logPageReads = config.logPageReads ?? false;
    if (config.fileLength) {
      this._length = config.fileLength;
    }
    this.cacheRequestedChunk = config.cacheRequestedChunk ?? true;
  }
  /**
   * efficiently copy the range [start, start + length) from the http file into the
   * output buffer at position [outOffset, outOffest + length)
   * reads from cache or synchronously fetches via HTTP if needed
   */
  copyInto(
    buffer: Uint8Array,
    outOffset: number,
    length: number,
    start: number,
    prefetchHintBytes: number
  ): number {
    if (start >= this.length) return 0;
    length = Math.min(this.length - start, length);
    const end = start + length;
    let i = 0;
    const prefetchHintChunks = (prefetchHintBytes / this.chunkSize) | 0;

    while (i < length) {
      // {idx: 24, chunkOffset: 24, chunkNum: 0, wantedSize: 16}
      const idx = start + i;
      const chunkOffset = idx % this.chunkSize;
      const chunkNum = (idx / this.chunkSize) | 0;
      const wantedSize = Math.min(this.chunkSize, end - idx);
      let inChunk = this.getChunk(chunkNum, prefetchHintChunks + 1);
      if (chunkOffset !== 0 || wantedSize !== this.chunkSize) {
        inChunk = inChunk.subarray(chunkOffset, chunkOffset + wantedSize);
      }
      buffer.set(inChunk, outOffset + i);
      i += inChunk.length;
    }
    return length;
  }

  private lastGet = -1;
  /* find the best matching existing read head to get the given chunk or create a new one */
  private moveReadHead(wantedChunkNum: number): ReadHead {
    for (const [i, head] of this.readHeads.entries()) {
      const fetchStartChunkNum = head.startChunk + head.speed;
      const newSpeed = Math.min(this.maxSpeed, head.speed * 2);
      const wantedIsInNextFetchOfHead =
        wantedChunkNum >= fetchStartChunkNum &&
        wantedChunkNum < fetchStartChunkNum + newSpeed;
      if (wantedIsInNextFetchOfHead) {
        head.speed = newSpeed;
        head.startChunk = fetchStartChunkNum;
        if (i !== 0) {
          // move head to front
          this.readHeads.splice(i, 1);
          this.readHeads.unshift(head);
        }
        return head;
      }
    }
    const newHead: ReadHead = {
      startChunk: wantedChunkNum,
      speed: 1,
    };
    this.readHeads.unshift(newHead);
    while (this.readHeads.length > this.maxReadHeads) this.readHeads.pop();
    return newHead;
  }
  /** get the given chunk from cache or fetch it from remote */
  private getChunk(wantedChunkNum: number, minSpeed: number): Uint8Array {
    let wasCached = true;
    let wantedChunk;
    let chunksToFetch;
    if (typeof this.chunks[wantedChunkNum] === "undefined") {
      wasCached = false;
      // double the fetching chunk size if the wanted chunk would be within the next fetch request
      const head = this.moveReadHead(wantedChunkNum);

      chunksToFetch = Math.max(minSpeed, head.speed);
      const startByte = head.startChunk * this.chunkSize;
      let endByte = (head.startChunk + chunksToFetch) * this.chunkSize - 1; // including this byte
      endByte = Math.min(endByte, this.length - 1); // if datalength-1 is selected, this is the last block

      const buf = this.doXHR(startByte, endByte);
      for (let i = 0; i < chunksToFetch; i++) {
        const curChunk = head.startChunk + i;
        if (i * this.chunkSize >= buf.byteLength) break; // past end of file
        const curSize =
          (i + 1) * this.chunkSize > buf.byteLength
            ? buf.byteLength - i * this.chunkSize
            : this.chunkSize;
        // console.log("constructing chunk", buf.byteLength, i * this.chunkSize, curSize);
        const chunk = new Uint8Array(buf, i * this.chunkSize, curSize);
        const isWantedChunk = curChunk === wantedChunkNum;
        if (isWantedChunk) wantedChunk = chunk;
        if (!isWantedChunk || this.cacheRequestedChunk) {
          this.chunks[curChunk] = chunk;
        }
      }
    } else {
      wantedChunk = this.chunks[wantedChunkNum];
      if (!this.cacheRequestedChunk) delete this.chunks[wantedChunkNum];
    }
    const boring = !this.logPageReads || this.lastGet == wantedChunkNum;
    if (!boring) {
      this.lastGet = wantedChunkNum;
      this.readPages.push({
        pageno: wantedChunkNum,
        wasCached,
        prefetch: wasCached ? 0 : (chunksToFetch||0) - 1,
        reason: wasCached ? "[no tracking when cached]" : getInterestingStack(),
      });
    }
    if (!wantedChunk) throw Error(`internal error: did not read wanted chunk?`);
    return wantedChunk;
  }
  /** verify the server supports range requests and find out file length */
  private checkServer() {
    var xhr = new XMLHttpRequest();
    const url = this.rangeMapper(0, 0).url;
    xhr.open("HEAD", url, false);
    xhr.send(null);
    if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304))
      throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
    var datalength = Number(xhr.getResponseHeader("Content-length"));

    var hasByteServing = xhr.getResponseHeader("Accept-Ranges") === "bytes";
    var usesGzip = xhr.getResponseHeader("Content-Encoding") === "gzip";

    if (!hasByteServing) {
      const msg =
        "server either does not support byte serving or does not advertise it (`Accept-Ranges: bytes` header missing), or your database is hosted on CORS and the server doesn't mark the accept-ranges header as exposed.";
      console.warn(msg, "seen response headers:", xhr.getAllResponseHeaders());
      // throw Error(msg);
    }

    if (usesGzip || !datalength) {
      console.error("response headers", xhr.getAllResponseHeaders());
      throw Error("server uses gzip or doesn't have length");
    }

    if (!this._length) this._length = datalength;
    this.serverChecked = true;
  }
  get length() {
    if (!this.serverChecked) {
      this.checkServer();
    }
    return this._length!;
  }

  get chunkSize() {
    if (!this.serverChecked) {
      this.checkServer();
    }
    return this._chunkSize!;
  }
  private doXHR(absoluteFrom: number, absoluteTo: number) {
    this.totalFetchedBytes += absoluteTo - absoluteFrom;
    this.totalRequests++;
    if (absoluteFrom > absoluteTo)
      throw new Error(
        "invalid range (" +
          absoluteFrom +
          ", " +
          absoluteTo +
          ") or no bytes requested!"
      );
    if (absoluteTo > this.length - 1)
      throw new Error(
        "only " + this.length + " bytes available! programmer error!"
      );
    const {
      fromByte: from,
      toByte: to,
      url,
    } = this.rangeMapper(absoluteFrom, absoluteTo);
    progressCallback({inc: 1});
    console.log(
      `[xhr ${basename(url)} of size ${formatBytes(absoluteTo + 1 - absoluteFrom)} @ ${
        absoluteFrom / 1024
      } KiB]`
    );

    // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    if (this.length !== this.chunkSize)
      xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);

    // Some hints to the browser that we want binary data.
    xhr.responseType = "arraybuffer";
    if (xhr.overrideMimeType) {
      xhr.overrideMimeType("text/plain; charset=x-user-defined");
    }

    xhr.send(null);
    if (!((xhr.status >= 200 && xhr.status < 300) || xhr.status === 304))
      throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
    if (xhr.response !== undefined) {
      return xhr.response as ArrayBuffer;
    } else {
      throw Error("xhr did not return uint8array");
    }
  }
}
