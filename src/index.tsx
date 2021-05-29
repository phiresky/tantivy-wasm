import React from "react";
import { useState, useEffect } from "react";
import { render } from "react-dom";
import { DatasetInfo, Doc, Stat } from "./types";
import "./index.scss";
import * as Comlink from "comlink";
import type { Api, Progress } from "./worker";
import { formatBytes } from "./util";

function getWorker(): [Worker, Promise<Comlink.Remote<Api>>] {
  const worker = new Worker(new URL("./worker.ts", import.meta.url));
  let resolve: () => void;
  const workerApiPromise = new Promise<void>((r) => (resolve = r));
  worker.addEventListener("message", initDone);
  function initDone(e: MessageEvent) {
    if (e.data === "inited") {
      worker.removeEventListener("message", initDone);
      resolve();
    }
  }
  const workerApi = Comlink.wrap<Api>(worker);
  return [worker, workerApiPromise.then(() => workerApi)];
}
const [worker, workerApi] = getWorker();

const urlParams = new URLSearchParams(location.search);

const chunkSize = 1024 * +(urlParams.get("chunkSize") || 32);


console.log("chunkSize", chunkSize);

const datasetUrl = "../idxes";
const datasets = [
  {
    name: "Wikipedia EN",
    url: datasetUrl + "/tantivy-index-wikipedia",
    desc: "Wikipedia",
  },
  {
    name: "OpenLibrary (30M books)",
    url: datasetUrl + "/tantivy-index-openlibrary",
    desc: "OpenLibrary Metadata",
  }
];

const myDatasetUrl = urlParams.get("dataset");
if (myDatasetUrl) {
  const name = urlParams.get("datasetName") || myDatasetUrl;
  datasets.unshift({
    name,
    desc: name,
    url: myDatasetUrl
  });
}


function DatasetInformation({
  datasetInfo,
}: {
  datasetInfo: DatasetInfo | null;
}) {
  if (!datasetInfo) {
    return <>[not loaded]</>;
  }
  if (datasetInfo.space_usage.segments.length > 1) {
    return <>Error: more than one segment!!</>;
  }
  const schema = datasetInfo.schema;
  const seg = datasetInfo.space_usage.segments[0];
  return (
    <div>
      <p>
        Total size: <b>{formatBytes(datasetInfo.space_usage.total || NaN)}</b>
      </p>
      <p>
        Number of documents: <b>{seg.num_docs}</b>
      </p>
      <p>
        Document Store size: {formatBytes(seg.store.data)} +{" "}
        {formatBytes(seg.store.offsets)}
      </p>
      Fields:
      <ul>
        {datasetInfo?.schema.map((field) => {
          const fieldId = datasetInfo.field_ids.find(
            ([id, name]) => name === field.name
          )?.[0];
          if (fieldId === undefined)
            return <li>field {field.name} not found</li>;
          return (
            <li className="no-p-margin" key={fieldId}>
              <b>{field.name}</b> ({field.type}, Options:{" "}
              <code>{JSON.stringify(field.options)}</code>)<p>Space Usage:</p>
              <p>
                Field Norms:{" "}
                {formatBytes(seg.fieldnorms.fields[fieldId]?.num_bytes || 0)}
              </p>
              <p>
                Term Positions:{" "}
                {formatBytes(seg.positions.fields[fieldId]?.num_bytes || 0)}
              </p>
              <p>
                Postings:{" "}
                {formatBytes(seg.postings.fields[fieldId]?.num_bytes || 0)}
              </p>
              <p>
                Termdict:{" "}
                {formatBytes(seg.termdict.fields[fieldId]?.num_bytes || 0)}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
function Gui() {
  const [rank, setRank] = useState(false);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState([] as string[]);
  const [dataset, setDataset] = useState(datasets[0].url);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState(null as string | null);
  const [searchText, setSearchText] = useState(urlParams.get("search") || "horace slughorn");
  const [searchResult, setSearchResult] = useState([] as Doc[]);
  const [stats, setStats] = useState([] as Stat[]);
  const [datasetInfo, setDatasetInfo] = useState(null as DatasetInfo | null);
  const [fields, setFields] = useState({
    authors: true,
    title: true,
    text: true,
  });

  useEffect(() => {
    setDatasetInfo(null);
    (async () => {
      try {
        const s = await (await workerApi).getIndexStats(dataset, chunkSize);
        console.log(s);
        setDatasetInfo(s);
      } catch (e) {
        console.error(e);
        setError(e);
      }
    })();
  }, [dataset]);
  useEffect(() => {
    function callback(e: MessageEvent) {
      if (e.data && e.data.type === "progress") {
        const p = e.data.data as Progress;
        if (p.inc) setProgress((progress) => progress + p.inc);
        if (p.message) {
          const msg = p.message;
          setLog((log) => [...log, msg]);
        }
      }
    }
    worker.addEventListener("message", callback);
    return () => worker.removeEventListener("message", callback);
  }, []);

  async function search() {
    setIsSearching(true);
    setSearchResult([]);
    setError(null);
    setStats([]);
    setProgress(0);
    try {
      const w = await workerApi;
      setSearchResult(
        await w.search({
          indexUrl: dataset,
          searchText,
          rank,
          chunkSize,
          fields: Object.entries(fields)
            .filter((f) => f[1])
            .map((f) => f[0]),
        })
      );
      setStats(await (await workerApi).getReadStats());
    } catch (e) {
      console.error("search error", e);
      setError(String(e));
    } finally {
      setIsSearching(false);
    }
  }
  const headers =
    searchResult.length > 0 ? Object.keys(searchResult[0].doc) : [];
  return (
    <div>
      <h1>
        Full Text Search in {datasets.find((d) => d.url === dataset)?.desc}
      </h1>
      <div>
        Switch dataset:{" "}
        <select value={dataset} onChange={(e) => setDataset(e.target.value)}>
          {datasets.map((d) => (
            <option key={d.url} value={d.url}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <details>
        <summary>
          Advanced query syntax (How to search in specific fields)
        </summary>
        <ul>
          <li>
            You can search in specific fields using e.g.{" "}
            <code>title:dumbledore authors:Rowling</code>
          </li>
          <li>
            You can exclude results by using -, e.g.{" "}
            <code>dumbledore said calmly -title:dumbledore</code>
          </li>
          <li>
            You can use boolean operators, e.g.{" "}
            <code>(authors:rowling OR authors:corvus) title:dumbledore</code>
          </li>
        </ul>
      </details>
      <details>
        <summary>Dataset Information</summary>

        <DatasetInformation datasetInfo={datasetInfo} />
      </details>
      <div>
        <p>
          {isSearching ? (
            "Search running..."
          ) : (
            <>
              Input:{" "}
              <input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />{" "}
              <label>
                {" "}
                Rank Results
                <input
                  type="checkbox"
                  checked={rank}
                  onChange={(e) => setRank(e.target.checked)}
                />
              </label>
              <button onClick={search}>Search</button>
            </>
          )}
        </p>
      </div>
      {error && <div style={{ color: "red" }}>{error}</div>}
      <div>
        Results:
        <table>
          <thead>
            <tr>
              <th>Score</th>
              {headers.map((h) => (
                <td key={h}>{h}</td>
              ))}
            </tr>
          </thead>
          <tbody>
            {searchResult.map((res, i) => (
              <tr key={i}>
                <td>{res.score.toFixed(2)}</td>
                {headers.map((h) => (
                  <td key={h}>{res.doc[h as keyof typeof res.doc]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        Log:{" "}
        <pre
          ref={(p) => p && (p.scrollTop = p.scrollHeight)}
          style={{ maxHeight: "200px", overflow: "auto" }}
        >
          {log.join("\n")}
        </pre>
      </div>
      <div>
        Fetch Stats:
        <table className="fetch-stats">
          <thead>
            <tr>
              <th>Stack</th>
              <th>HTTP Requests</th>
              <th>Fetched Data</th>
              <th>Total Reads</th>
              <th>Cached Data</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((res) => (
              <tr key={res.reason}>
                <td>
                  <pre>{res.reason}</pre>
                </td>
                <td>{res.requestCount}</td>
                <td>{formatBytes(res.fetchedAmount)}</td>
                <td>{res.totalReadCount}</td>
                <td>{formatBytes(res.cachedReadAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

render(<Gui />, document.getElementById("root"));
