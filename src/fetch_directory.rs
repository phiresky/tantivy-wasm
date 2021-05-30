use once_cell::sync::OnceCell;
use std::{
    collections::{hash_map::Entry, BTreeMap, HashMap},
    convert::TryInto,
    io::{BufWriter, Write},
    ops::Range,
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
    pub fn get_file_len(fname: String, chunkSize: f64) -> Result<f64, JsValue>;
    pub fn read_bytes_from_file(fname: String, chunkSize: f64, from: f64, to: f64, out: &mut [u8]);
    pub fn ensure_chunks_cached(fname: String, chunkSize: f64, chunkIdxes: &[f64]);
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

        let chunk_size = if path.ends_with(".store") {
            std::cmp::min(chunk_size, 16 * 1024)
        } else {
            chunk_size
        };

        Ok(match entry {
            Entry::Occupied(e) => (*e.get()).clone(),
            Entry::Vacant(v) => {
                let len = get_file_len(path.clone(), chunk_size as f64)
                    .map_err(|j| OpenReadError::FileDoesNotExist(PathBuf::from(&path)))?
                    as u64;
                /*OpenReadError::wrap_io_error(
                    std::io::Error::new(std::io::ErrorKind::Other, format!("{:?}", j)),
                    PathBuf::from(&path),
                ) */
                let f = FetchFile {
                    path,
                    len,
                    chunk_size,
                    cache: Arc::new(RwLock::new(BTreeMap::new())), // cache: RwLock::new(BTreeMap::new()),
                };
                v.insert(f.clone());
                f
            }
        })
    }
    fn read_chunk(&self, i: Ulen) -> Vec<u8> {
        let from = i * self.chunk_size;
        let to = std::cmp::min((i + 1) * self.chunk_size, self.len());
        let mut out = vec![0; (to - from) as usize];
        read_bytes_from_file(
            self.path.clone(),
            self.chunk_size as f64,
            from as f64,
            to as f64,
            &mut out,
        );
        out
    }
    fn get_toread_list(&self, from: Ulen, to: Ulen) -> Vec<MaybeToRead> {
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
        let mut cache = self.cache.read().unwrap();
        let mut output = vec![];
        for i in starti..=endi {
            let startofs = if i == starti { startofs } else { 0 };
            let endofs = if i == endi { endofs } else { CS as usize };
            let chunk = cache.get(&i);
            // .or_insert_with(|| OwnedBytes::new(self.read_chunk(i, endi - i)));*/
            /*let chunk = &chunk[startofs..endofs];*/
            let data = if let Some(chunk) = chunk {
                let o = chunk.slice(startofs, endofs);
                MaybeToRead::Done(o)
            } else {
                MaybeToRead::ToRead(i, startofs..endofs)
            };
            output.push(data);
        }

        output
    }
}
enum MaybeToRead {
    Done(OwnedBytes),
    ToRead(u64, Range<usize>), // chunkid, range within chunk
}

fn concat_ownedbytes(obs: Vec<OwnedBytes>, chunk_size: usize) -> OwnedBytes {
    if obs.len() == 0 {
        return OwnedBytes::empty();
    }
    if obs.len() == 1 {
        // direct reference to cache, no copying!
        return obs[0].clone();
    }
    let mut v = Vec::with_capacity(obs.len() * chunk_size);
    for o in obs {
        v.extend_from_slice(&o[..]);
    }
    OwnedBytes::new(v)
}
impl FileHandle for FetchFile {
    fn read_bytes_multiple(
        &self,
        ranges: &[Range<Ulen>],
    ) -> Result<Vec<OwnedBytes>, std::io::Error> {
        let mut toread_lists = ranges
            .iter()
            .map(|range| self.get_toread_list(range.start, range.end))
            .collect::<Vec<_>>();

        let todos: Vec<&mut MaybeToRead> = toread_lists
            .iter_mut()
            .flatten()
            .filter_map(|s| match s {
                MaybeToRead::Done(x) => None,
                toread => Some(toread),
            })
            .collect();

        let to_cache: Vec<f64> = todos
            .iter()
            .map(|s| match s {
                MaybeToRead::Done(_) => panic!(),
                MaybeToRead::ToRead(chunk_idx, _) => *chunk_idx as f64,
            })
            .collect();
        if to_cache.len() > 0 {
            ensure_chunks_cached(self.path.clone(), self.chunk_size as f64, &to_cache);
        }

        for s in todos {
            match s {
                MaybeToRead::Done(_) => panic!(),
                MaybeToRead::ToRead(chunk_idx, range) => {
                    let chunk = OwnedBytes::new(self.read_chunk(*chunk_idx));
                    let slice = chunk.slice(range.start, range.end);
                    let mut c = self.cache.write().unwrap();
                    c.insert(*chunk_idx, chunk);
                    *s = MaybeToRead::Done(slice);
                }
            }
        }
        return Ok(toread_lists
            .into_iter()
            .map(|r| {
                concat_ownedbytes(
                    r.into_iter()
                        .map(|t| match t {
                            MaybeToRead::Done(d) => d,
                            _ => panic!(),
                        })
                        .collect::<Vec<OwnedBytes>>(),
                    self.chunk_size as usize,
                )
            })
            .collect::<Vec<OwnedBytes>>());
    }

    fn read_bytes(&self, from: Ulen, to: Ulen) -> std::io::Result<OwnedBytes> {
        Ok(self
            .read_bytes_multiple(&[from..to])?
            .into_iter()
            .nth(0)
            .unwrap())
    }
}
impl HasLen for FetchFile {
    fn len(&self) -> u64 {
        self.len
    }
}
