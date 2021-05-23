/// <reference lib="webworker" />

import * as Comlink from "comlink";

import { get_dataset_info, search } from "../pkg";
import { files } from "./fetch_directory";
import { DatasetInfo, Stat } from "./types";

function getReadStats(): Stat[] {
  const readByReason = new Map<string, Stat>();
  for (const [name, file] of files) {
    for (const read of file.readPages) {
      for (const reason of [read.reason, "Total"]) {
        const readData = file.chunkSize * (read.prefetch + 1);
        let t = readByReason.get(reason);
        if (!t) {
          t = {
            reason: reason,
            fetchedAmount: 0,
            requestCount: 0,
            totalReadCount: 0,
            cachedReadAmount: 0,
          };
          readByReason.set(reason, t);
        }
        if (!read.wasCached) {
          t.fetchedAmount += readData;
          t.requestCount += 1;
        } else {
          t.cachedReadAmount += readData;
        }
        t.totalReadCount += 1;
      }
    }
  }
  const arr = [...readByReason.values()];
  arr.sort((a, b) => b.fetchedAmount - a.fetchedAmount);
  return arr;
}

type SearchParams = {
  indexUrl: string;
  fields?: string[];
  rank: boolean;
  searchText: string;
};
const api = {
  search(data: SearchParams) {
    for(const file of files.values()) {
      file.readPages = [];
    }
    return JSON.parse(
      search(data.indexUrl, data.fields, data.rank, data.searchText)
    );
  },
  getReadStats,
  getIndexStats(indexUrl: string): DatasetInfo {
    return JSON.parse(get_dataset_info(indexUrl));
  },
};
export type Api = typeof api;
Comlink.expose(api);

self.postMessage("inited");
