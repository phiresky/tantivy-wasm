import React from "react";
import { useState, useEffect } from "react";
import { render } from "react-dom";
import { Doc, Stat, ToMain, ToWorker } from "./types";
import "./index.scss";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
function sendMessage(message: ToWorker) {
  worker.postMessage(message);
}

function Gui() {
  const [isSearching, setIsSearching] = useState(false);
  const [searchText, setSearchText] = useState("dumbledore said calmly");
  const [searchResult, setSearchResult] = useState([] as Doc[]);
  const [stats, setStats] = useState([] as Stat[]);
  const [fields, setFields] = useState({
    authors: true,
    title: true,
    text: true,
  });

  useEffect(() => {
    const listener = ({ data }: MessageEvent<ToMain>) => {
      switch (data.type) {
        case "searchResult":
          setIsSearching(false);
          setSearchResult(data.result);
          sendMessage({ type: "getReadStats" });
          break;
        case "stats":
          setStats(data.stats);
          break;
      }
    };
    worker.addEventListener("message", listener);
    return () => worker.removeEventListener("message", listener);
  }, []);

  function search() {
    setIsSearching(true);
    sendMessage({
      type: "search",
      indexUrl: "/tantivy-index-v2",
      searchText,
      fields: Object.entries(fields)
        .filter((f) => f[1])
        .map((f) => f[0]),
    });
  }
  return (
    <div>
      <h1>Full Text Search in 2M books</h1>
      
      Fields:{" "}
      <label>
        <input
          type="checkbox"
          checked={fields.authors}
          onChange={(e) => setFields({ ...fields, authors: e.target.checked })}
        />
        Authors
      </label>
      <label>
        <input
          type="checkbox"
          checked={fields.title}
          onChange={(e) => setFields({ ...fields, title: e.target.checked })}
        />
        Title
      </label>
      <label>
        <input
          type="checkbox"
          checked={fields.text}
          onChange={(e) => setFields({ ...fields, text: e.target.checked })}
        />
        Text
      </label>
      {isSearching? "Search running...": <div>
        Input: <input
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
      />{" "}<button onClick={search}>Search</button>
      </div>}
      <div>
        Results:
        <table>
          <tr>
            <th>Score</th>
            <th>Author</th>
            <th>Title</th>
            <th>ID</th>
          </tr>
          {searchResult.map((res) => (
            <tr>
              <th>{res.score.toFixed(2)}</th>
              <td>{res.doc.authors}</td>
              <td>{res.doc.title}</td>
              <td>{res.doc.filename}</td>
            </tr>
          ))}
        </table>
      </div>
      <div>
        Fetch Stats:
        <table>
          <tr>
            <th>Stack</th>
            <th>HTTP Requests</th>
            <th>Fetched Data</th>
          </tr>
          {stats.map((res) => (
            <tr>
              <td>{res.reason}</td>
              <td>{res.count}</td>
              <td>{(res.amount / 1000 / 1000).toFixed(2)} MB</td>
            </tr>
          ))}
        </table>
      </div>
    </div>
  );
}

render(<Gui />, document.getElementById("root"));
