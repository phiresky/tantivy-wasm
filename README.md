# tantivy-wasm

Demo of the tantivy full text search engine running completely in a browser, with the data fetched only when needed from a statically hosted database.

See my draft PR here: https://github.com/tantivy-search/tantivy/pull/1065

The tantivy wasm file is 15 MB in debug mode (4MB gzipped), and i have debug mode enabled to get better stack traces for the demo. In release mode it's only 1.5MB or so (smaller gzipped).