use fetch_directory::FetchDirectory;
use serde_json::json;
use std::fmt::Write;
use tantivy::{Index, SegmentReader, TantivyError, collector::{DocSetCollector, TopDocs}, postings::BlockSegmentPostings, query::QueryParser, schema::{Field, FieldType}};
use wasm_bindgen::prelude::*;

mod fetch_directory;

#[wasm_bindgen]
extern "C" {
    // Use `js_namespace` here to bind `console.log(..)` instead of just
    // `log(..)`
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}
#[wasm_bindgen(raw_module="../src/worker.ts")]
extern "C" {
    fn tantivyLog(s: &str);
}

#[macro_export]
macro_rules! console_log {
    // Note that this is using the `log` function imported above during
    // `bare_bones`
    ($($t:tt)*) => (crate::log(&format_args!($($t)*).to_string()))
}

fn to_js_err(e: impl std::fmt::Debug) -> JsValue {
    return JsValue::from(format!("{:?}", e));
}
#[wasm_bindgen]
pub fn search(
    directory: String,
    chunk_size: u32,
    fields: Option<Box<[JsValue]>>,
    rank: bool,
    query: String,
) -> Result<String, JsValue> {
    console_error_panic_hook::set_once();
    tantivy::set_info_log_hook(tantivyLog);
    let fields: Option<Vec<String>> = fields.map(|fields| {
        fields
            .into_iter()
            .map(|f| f.as_string().unwrap().to_owned())
            .collect()
    });
    console_log!("field filter: {:?}", fields);
    return search_inner(directory, chunk_size as u64, fields.as_ref(), rank, query).map_err(to_js_err);
}
#[wasm_bindgen]
pub fn get_dataset_info(directory: String, chunk_size: u32) -> Result<String, JsValue> {
    get_dataset_info_inner(directory, chunk_size as u64).map_err(to_js_err)
}
pub fn get_dataset_info_inner(directory: String, chunk_size: u64) -> tantivy::Result<String> {
    let index = Index::open(FetchDirectory::new(directory, chunk_size))?;
    let schema = index.schema();
    let reader = index.reader()?;
    let searcher = reader.searcher();
    // force it to cache some more data
    for seg in index.searchable_segments()? {
        let seg = SegmentReader::open(&seg)?;
        for (field, _) in schema.fields() {
            seg.inverted_index(field)?;
        }
    }
    let space_usage = searcher.space_usage()?;

    Ok(json!({
        "schema": schema,
        "space_usage": space_usage,
        "field_ids": schema.fields().map(|f| (f.0.field_id(), f.1.name())).collect::<Vec<_>>()
    })
    .to_string())
}
pub fn search_inner(
    directory: String,
    chunk_size: u64,
    fields: Option<&Vec<String>>,
    rank: bool,
    query: String,
) -> tantivy::Result<String> {
    // let index = Index::open_in_dir(directory)?;
    let index = Index::open(FetchDirectory::new(directory, chunk_size))?;
    let schema = index.schema();

    let default_fields: Vec<Field> = schema
        .fields()
        .filter(|&(_, ref field_entry)| match *field_entry.field_type() {
            FieldType::Str(ref text_field_options) => {
                let want_field = fields
                    .map(|fields| fields.contains(&field_entry.name().to_owned()))
                    .unwrap_or(true);

                want_field && text_field_options.get_indexing_options().is_some()
            }
            _ => false,
        })
        .map(|(field, _)| field)
        .collect();
    let mut query_parser =
        QueryParser::new(schema.clone(), default_fields, index.tokenizers().clone());
    query_parser.set_conjunction_by_default();

    let query = query_parser.parse_query(&query)?;
    console_log!("parsed query: {:#?}", query);
    let searcher = index.reader()?.searcher();

    let mut o = Vec::new();

    let results = if rank {
        searcher.search(&query, &TopDocs::with_limit(10))?
    } else {
        let x = searcher.search(&query, &DocSetCollector)?;
        x.into_iter().map(|s| (0.0, s)).take(10).collect()
    };

    for (score, doc_address) in results {
        console_log!(
            "found document: {}:{}",
            doc_address.segment_ord(),
            doc_address.doc()
        );
        // let score = 1;
        let doc = searcher.doc(doc_address)?;
        // let doc: serde_json::Value = serde_json::value::to_value(schema.to_named_doc(&doc)).unwrap();
        let json: serde_json::Value = json!({
            "score": score,
            "doc": schema.to_named_doc(&doc)
        });
        o.push(json);
        /*o.push(Doc {
            score: score as f64,
            authors: doc
                .get_first(schema.get_field("authors").unwrap())
                .unwrap()
                .text()
                .unwrap()
                .to_string(),
            title: doc
                .get_first(schema.get_field("title").unwrap())
                .unwrap()
                .text()
                .unwrap()
                .to_string(),
            filename: doc
                .get_first(schema.get_field("filename").unwrap())
                .unwrap()
                .text()
                .unwrap()
                .to_string(),
        });*/
    }

    Ok(serde_json::to_string(&o).unwrap())
}
