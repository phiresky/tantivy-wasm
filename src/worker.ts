/// <reference lib="webworker" />
import { search } from "../pkg";
import { files } from "./fetchdir";
import { Stat, ToMain, ToWorker } from "./types";

function sendMessage(message: ToMain) {
  self.postMessage(message);
}

function getReadStats(): Stat[] {
  const readByReason = new Map<string, Stat>();
  for (const [name, file] of files) {
    for (const read of file.readPages) {
      if (read.wasCached) continue;
      const readData = file.chunkSize * (read.prefetch + 1);
      let t = readByReason.get(read.reason);
      if (!t) {
        t = { reason: read.reason, amount: 0, count: 0 };
        readByReason.set(read.reason, t);
      }
      t.amount += readData;
      t.count += 1;
    }
  }
  const arr = [...readByReason.values()];
  arr.sort((a, b) => b.amount - a.amount);
  return arr;
}
self.addEventListener("message", async (event) => {
  const data = event.data as ToWorker;
  switch (data.type) {
    case "search":
      const ret = JSON.parse(search(data.indexUrl, data.fields, data.searchText));
      sendMessage({
        type: "searchResult",
        result: ret,
      });
      getReadStats();
    case "getReadStats":
      sendMessage({
        type: "stats",
        stats: await getReadStats(),
      });
  }
});
