/// <reference lib="webworker" />
import { search } from "../pkg";
import { ToMain, ToWorker } from "./types";

function sendMessage(message: ToMain) {
  self.postMessage(message);
}

self.addEventListener("message", async (event) => {
  const data = event.data as ToWorker;
  switch (data.type) {
    case "search":
      sendMessage(await search(data.indexUrl, data.searchText));
  }
});
