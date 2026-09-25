import { createReadStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';

/** A zstd compressor stream (`node:zlib`), what backups are written through. */
export function zstdCompress(): Transform {
  return createZstdCompress();
}

/**
 * A `.tar.zst` file as an uncompressed tar stream. `onRead` hears how many
 * compressed bytes were read so far (progress against the file's size).
 * Destroy the result to stop early.
 */
export function readTarZst(file: string, onRead?: (bytes: number) => void): Readable {
  let read = 0;
  const src = createReadStream(file, { highWaterMark: 1 << 20 });
  const counted = onRead
    ? src.pipe(
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            read += chunk.length;
            onRead(read);
            cb(null, chunk);
          },
        }),
      )
    : src;
  const out = counted.pipe(createZstdDecompress());
  // A read error (the file vanished) reaches the reader instead of being lost upstream…
  src.on('error', (e) => out.destroy(e));
  // …which gets it from the stream itself, even before it starts reading.
  out.on('error', () => undefined);
  out.on('close', () => src.destroy());
  return out;
}
