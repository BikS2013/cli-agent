/**
 * Stateful UTF-8 decoder for the raw-mode reader.
 *
 * Wraps node:string_decoder.StringDecoder so each printable byte goes through
 * a buffer that holds incomplete multi-byte sequences across data events.
 *
 * Per spec §5.2 / §18.2: never use String.fromCharCode(b) on raw bytes — that
 * mangles every UTF-8 leading or continuation byte to mojibake.
 */

import { StringDecoder } from 'node:string_decoder';

export interface Utf8Decoder {
  /**
   * Feed one printable byte. Returns the decoded string fragment so far
   * (possibly empty when a multi-byte sequence is still in progress).
   */
  write(byte: number): string;
  /** Flush any held bytes (replacement chars for ill-formed remainders). */
  end(): string;
}

export function createUtf8Decoder(): Utf8Decoder {
  const decoder = new StringDecoder('utf8');
  return {
    write(byte: number): string {
      return decoder.write(Buffer.from([byte]));
    },
    end(): string {
      return decoder.end();
    },
  };
}
