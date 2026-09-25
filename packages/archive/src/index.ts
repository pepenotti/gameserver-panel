/**
 * Archives and server files next to the data (D11): the pure-JS tar the
 * agent packs and stages with and the panel keeps its backups in, zstd from
 * `node:zlib`, and `RootedFiles`, the `ServerFiles` an agent (or the panel's
 * tests and dev loop) serves from a local disk.
 */
export { globToRegExp, matchesAny } from './glob';
export { isFolderId, isSafeName, segments, ServerFilesError } from './paths';
export { closeIterable, INTERNAL_DIR, MAX_RELS, READ_MAX_BYTES, RootedFiles, type HotCopy, type RootedFilesOptions } from './rooted';
export { BLOCK, END_OF_ARCHIVE, headerFor, padding, TarError, TarPacker, unpack, writeOrFail, type TarEntry } from './tar';
export { readTarZst, zstdCompress } from './zstd';
