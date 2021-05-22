import React from "react";
import { useState, useEffect } from "react";
import { render } from "react-dom";
import { ToMain, ToWorker } from "./types";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
function sendMessage(message: ToWorker) {
  worker.postMessage(message);
}

function Gui() {
  const [searchText, setSearchText] = useState("dumbledore said calmly");

  useEffect(() => {
    const listener = ({ data }: MessageEvent<ToMain>) => {
      console.log(data);
    };
    worker.addEventListener("message", listener);
    return () => worker.removeEventListener("message", listener);
  }, []);

  function search() {
    sendMessage({ type: "search", indexUrl: "/tantivy-index-v2", searchText });
  }
  return (
    <div>
      <input
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
      ></input>{" "}
      <button onClick={search}>Search</button>
    </div>
  );
}

render(<Gui />, document.getElementById("root"));
