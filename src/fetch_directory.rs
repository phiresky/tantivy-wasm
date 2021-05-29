use once_cell::sync::OnceCell;
use std::{
    collections::{hash_map::Entry, BTreeMap, HashMap},
    convert::TryInto,
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    u64,
};
use tantivy::{
    directory::{
        error::{DeleteError, OpenReadError, OpenWriteError},
        AntiCallToken, FileHandle, OwnedBytes, TerminatingWrite, WatchCallback, WatchHandle,
        WritePtr,
    },
    Directory, HasLen,
};

use wasm_bindgen::prelude::*;

use crate::console_log;
#[wasm_bindgen(raw_module = "../src/fetch_directory")]
extern "C" {
    #[wasm_bindgen(catch)]
    pub fn get_file_len(fname: String) -> Result<f64, JsValue>;
    pub fn read_bytes_from_file(
        fname: String,
        from: f64,
        to: f64,
        prefetch_hint: f64,
        out: &mut [u8],
    );
}

#[derive(Clone, Debug)]
pub struct FetchDirectory {
    root: String,
    chunk_size: u64,
}
impl FetchDirectory {
    pub fn new(root: String, chunk_size: u64) -> FetchDirectory {
        FetchDirectory { root, chunk_size }
    }
}

impl Directory for FetchDirectory {
    fn get_file_handle(&self, path: &Path) -> Result<Box<dyn FileHandle>, OpenReadError> {
        Ok(Box::new(FetchFile::get(
            format!("{}/{}", self.root, path.to_string_lossy()),
            self.chunk_size,
        )?))
    }

    fn delete(&self, path: &Path) -> Result<(), DeleteError> {
        println!("delete {:?}", path);
        Ok(())
    }

    fn exists(&self, path: &Path) -> Result<bool, OpenReadError> {
        todo!()
    }

    fn open_write(&self, path: &Path) -> Result<WritePtr, OpenWriteError> {
        Ok(BufWriter::new(Box::new(Noop {})))
    }

    fn atomic_read(&self, path: &Path) -> Result<Vec<u8>, OpenReadError> {
        let f = self.get_file_handle(path)?;
        Ok(f.read_bytes(0, f.len())
            .map_err(|e| OpenReadError::wrap_io_error(e, path.to_path_buf()))?
            .to_vec())
    }

    fn atomic_write(&self, path: &Path, data: &[u8]) -> std::io::Result<()> {
        todo!()
    }

    fn watch(&self, watch_callback: WatchCallback) -> tantivy::Result<WatchHandle> {
        Ok(WatchHandle::empty())
    }
}

struct Noop {}
impl Write for Noop {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl TerminatingWrite for Noop {
    fn terminate_ref(&mut self, _: AntiCallToken) -> std::io::Result<()> {
        Ok(())
    }
}

type Ulen = u64;

#[derive(Debug, Clone)]
struct FetchFile {
    chunk_size: u64,
    path: String,
    len: u64,
    cache: Arc<RwLock<BTreeMap<Ulen, OwnedBytes>>>,
}

static fetch_files: OnceCell<RwLock<HashMap<String, FetchFile>>> = OnceCell::new();
// chunk size
impl FetchFile {
    pub fn get(path: String, chunk_size: u64) -> Result<FetchFile, OpenReadError> {
        let mut cache = fetch_files
            .get_or_init(|| RwLock::new(HashMap::new()))
            .write()
            .unwrap();
        let entry = cache.entry(path.clone());

        Ok(match entry {
            Entry::Occupied(e) => (*e.get()).clone(),
            Entry::Vacant(v) => {
                let len = get_file_len(path.clone())
                    .map_err(|j| OpenReadError::FileDoesNotExist(PathBuf::from(&path)))?
                    as u64;
                let f = FetchFile {
                    path: path,
                    len,
                    chunk_size,
                    cache: Arc::new(RwLock::new(BTreeMap::new())), // cache: RwLock::new(BTreeMap::new()),
                };
                v.insert(f.clone());
                f
            }
        })
    }
    fn read_chunk(&self, i: Ulen, prefetch_hint: Ulen) -> Vec<u8> {
        let from = i * self.chunk_size;
        let to = std::cmp::min((i + 1) * self.chunk_size, self.len());
        let mut out = vec![0; (to - from) as usize];
        read_bytes_from_file(
            self.path.clone(),
            from as f64,
            to as f64,
            (prefetch_hint * self.chunk_size) as f64,
            &mut out,
        );
        out
    }
}
impl FileHandle for FetchFile {
    fn read_bytes(&self, from: Ulen, to: Ulen) -> std::io::Result<OwnedBytes> {
        let len: usize = (to - from).try_into().unwrap();
        /*eprintln!(
            "GET {} @ {}, len {}",
            self.path.to_string_lossy(),
            from,
            len
        );*/
        let CS = self.chunk_size;
        let starti = from / CS;
        let endi = to / CS;
        let startofs = (from % CS) as usize;
        let endofs = (to % CS) as usize;
        if starti == endi {
            // only one chunk: we can directly return a reference to the cache as an Arc (in case it is deleted from cache), no need to copy!
            let mut cache = self.cache.write().unwrap();
            let chunk = cache
                .entry(starti)
                .or_insert_with(|| OwnedBytes::new(self.read_chunk(starti, 0)));
            return Ok(chunk.slice(startofs, endofs));
        }
        let mut out_buf = vec![0u8; len];
        //let toget = vec![];
        let mut cache = self.cache.write().unwrap();
        let mut written = 0;
        for i in starti..=endi {
            let startofs = if i == starti { startofs } else { 0 };
            let endofs = if i == endi { endofs } else { CS as usize };
            let chunk = cache
                .entry(i)
                .or_insert_with(|| OwnedBytes::new(self.read_chunk(i, endi - i)));
            let chunk = &chunk[startofs..endofs];
            let write_len = std::cmp::min(chunk.len(), len as usize);
            out_buf[written..written + write_len].copy_from_slice(&chunk);
            written += write_len;
        }

        Ok(OwnedBytes::new(out_buf))
    }
    /*  fn read_bytes(
        &self,
        from: u64,
        to: u64,
    ) -> std::io::Result<tantivy::directory::OwnedBytes> {

        //let mut out = vec![0u8; (to - from) as usize];


        read_bytes_from_file(
            self.path.clone(),
            from as f64,
            to as f64,
            &mut out
        );
        Ok(OwnedBytes::new(out))
    }*/
}
impl HasLen for FetchFile {
    fn len(&self) -> u64 {
        self.len
    }
}
