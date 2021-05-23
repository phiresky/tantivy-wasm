use fetch_directory::FetchDirectory;
use std::fmt::Write;
use tantivy::{Index, collector::{DocSetCollector, TopDocs}, query::QueryParser, schema::{Field, FieldType}};
use wasm_bindgen::prelude::*;

mod fetch_directory;

#[wasm_bindgen]
extern "C" {
    // Use `js_namespace` here to bind `console.log(..)` instead of just
    // `log(..)`
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

}

#[macro_export]
macro_rules! console_log {
    // Note that this is using the `log` function imported above during
    // `bare_bones`
    ($($t:tt)*) => (crate::log(&format_args!($($t)*).to_string()))
}

#[wasm_bindgen]
pub struct Doc {
    score: f64,
    title: String,
    authors: String,
    filename: String,
}

#[wasm_bindgen]
pub fn search(
    directory: String,
    fields: Option<Box<[JsValue]>>,
    rank: bool,
    query: String,
) -> Result<String, JsValue> {
    tantivy::set_info_log_hook(log);
    let fields: Option<Vec<String>> = fields.map(|fields| {
        fields
            .into_iter()
            .map(|f| f.as_string().unwrap().to_owned())
            .collect()
    });
    console_log!("field filter: {:?}", fields);
    return search_inner(directory, fields.as_ref(), rank, query)
        .map_err(|e| JsValue::from(format!("{:?}", e)));
}
pub fn search_inner(
    directory: String,
    fields: Option<&Vec<String>>,
    rank: bool,
    query: String,
) -> tantivy::Result<String> {
    // let index = Index::open_in_dir(directory)?;
    let index = Index::open(FetchDirectory::new(directory))?;
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
    let query_parser = QueryParser::new(schema.clone(), default_fields, index.tokenizers().clone());
    let query = query_parser.parse_query(&query)?;
    console_log!("parsed query: {:#?}", query);
    let searcher = index.reader()?.searcher();

    let mut o = Vec::new();

    let collector = TopDocs::with_limit(10); // DocSetCollectorj
    for (score, doc_address) in searcher.search(&query, &collector)? {
        console_log!("found document: {}:{}", doc_address.segment_ord(), doc_address.doc());
        // let score = 1;
        let doc = searcher.doc(doc_address)?;
        // let doc: serde_json::Value = serde_json::value::to_value(schema.to_named_doc(&doc)).unwrap();
        let json: serde_json::Value = serde_json::json!({
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
