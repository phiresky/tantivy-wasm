use fetch_directory::FetchDirectory;
use tantivy::{Index, collector::TopDocs, query::QueryParser, schema::{Field, FieldType}};
use wasm_bindgen::prelude::*;
use std::fmt::Write;

mod fetch_directory;

#[wasm_bindgen]
extern "C" {
    // Use `js_namespace` here to bind `console.log(..)` instead of just
    // `log(..)`
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

}

macro_rules! console_log {
    // Note that this is using the `log` function imported above during
    // `bare_bones`
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

#[wasm_bindgen]
pub fn search(directory: String, query: String) -> String {
    tantivy::set_info_log_hook(log);
    return search_inner(directory, query).unwrap_or_else(|e| format!("{:?}", e))
}
pub fn search_inner(directory: String, query: String) -> tantivy::Result<String> {
    // let index = Index::open_in_dir(directory)?;
    let index = Index::open(FetchDirectory::new(directory))?;
    let schema = index.schema();
    let default_fields: Vec<Field> = schema
    .fields()
    .filter(|&(_, ref field_entry)| match *field_entry.field_type() {
        FieldType::Str(ref text_field_options) => {
            text_field_options.get_indexing_options().is_some()
        }
        _ => false,
    })
    .map(|(field, _)| field)
    .collect();
    let query_parser = QueryParser::new(schema.clone(), default_fields, index.tokenizers().clone());
    let query = query_parser.parse_query(&query)?;
    console_log!("parsed query: {:#?}", query);
    let searcher = index.reader()?.searcher();
    
    let mut ostr = String::new();
    
    for (score, doc_address) in searcher.search(&query, &TopDocs::with_limit(10))? {
        let doc = searcher.doc(doc_address)?;
        writeln!(ostr, "{} {}", score, schema.to_json(&doc)).unwrap();
    }

    Ok(ostr)
}
