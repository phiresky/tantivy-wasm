use std::{convert::TryInto, io::{BufWriter, Write}, path::{Path, PathBuf}, u64};
use tantivy::{
    directory::{
        error::{DeleteError, OpenReadError, OpenWriteError},
        AntiCallToken, FileHandle, OwnedBytes, TerminatingWrite, WatchCallback, WatchHandle,
        WritePtr,
    },
    Directory, HasLen,
};

use wasm_bindgen::prelude::*;
#[wasm_bindgen(raw_module = "../src/fetchdir")]
extern "C" {

    pub fn get_file_len(fname: String) -> f64;
    pub fn read_bytes_from_file(fname: String, from: f64, to: f64) -> Vec<u8>;
}

#[derive(Clone, Debug)]
pub struct FetchDirectory {
    root: String,
}
impl FetchDirectory {
    pub fn new(root: String) -> FetchDirectory {
        FetchDirectory { root }
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

#[derive(Debug)]
struct FetchFile {
    path: String,
    len: u64,
}
impl FetchFile {
    pub fn new(path: String) -> FetchFile {
        let len = { get_file_len(path.clone()) } as u64;
        FetchFile {
            path: path,
            len,
            // cache: RwLock::new(BTreeMap::new()),
        }
    }
}
impl Directory for FetchDirectory {
    fn get_file_handle(&self, path: &Path) -> Result<Box<dyn FileHandle>, OpenReadError> {
        Ok(Box::new(FetchFile::new(format!(
            "{}/{}",
            self.root,
            path.to_string_lossy()
        ))))
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
        let len = f.len();
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
impl FileHandle for FetchFile {
    fn read_bytes(
        &self,
        from: u64,
        to: u64,
    ) -> std::io::Result<tantivy::directory::OwnedBytes> {
        Ok(OwnedBytes::new(read_bytes_from_file(
            self.path.clone(),
            from as f64,
            to as f64,
        )))
    }
}
impl HasLen for FetchFile {
    fn len(&self) -> u64 {
        self.len
    }
}
