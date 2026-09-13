/**
 * Just enough of the protobuf wire format to read a Substreams package.
 *
 * A `.spkg` is an `sf.substreams.v1.Package`. Reading two strings and a list of
 * names out of it does not justify a protobuf runtime plus the Substreams
 * descriptors, and a stranger can check these forty lines faster than they can
 * check a dependency. The fields that matter:
 *
 *   Package          6  modules          (Modules)
 *                    8  package_meta     (repeated PackageMetadata; the first is this package)
 *   Modules          1  modules          (repeated Module)
 *   Module           1  name
 *   PackageMetadata  1  version,  3  name
 *
 * Anything malformed throws, so a registry that serves something other than a
 * package is reported as such rather than read as a package with no modules.
 */

export interface PackageSummary {
  name: string | null;
  version: string | null;
  /** Module names in package order, imported modules included (`erc4626:map_events`). */
  modules: string[];
}

interface Field {
  no: number;
  wire: number;
  bytes: Uint8Array | null;
}

function* fields(buffer: Uint8Array): Generator<Field> {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (at >= buffer.length) throw new Error("truncated varint");
      const byte = buffer[at++]!;
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
    }
  };

  while (at < buffer.length) {
    const key = varint();
    const no = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      varint();
      yield { no, wire, bytes: null };
    } else if (wire === 2) {
      const length = varint();
      if (at + length > buffer.length) throw new Error(`field ${no} runs past the end of the package`);
      yield { no, wire, bytes: buffer.subarray(at, at + length) };
      at += length;
    } else if (wire === 1) {
      at += 8;
    } else if (wire === 5) {
      at += 4;
    } else {
      throw new Error(`unsupported wire type ${wire} for field ${no}`);
    }
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function firstString(message: Uint8Array, no: number): string | null {
  for (const field of fields(message)) {
    if (field.no === no && field.bytes) return utf8.decode(field.bytes);
  }
  return null;
}

export function readPackage(buffer: Uint8Array): PackageSummary {
  const modules: string[] = [];
  let meta: Uint8Array | null = null;
  let sawModules = false;

  for (const field of fields(buffer)) {
    if (field.no === 6 && field.bytes) {
      sawModules = true;
      for (const entry of fields(field.bytes)) {
        if (entry.no !== 1 || !entry.bytes) continue;
        const name = firstString(entry.bytes, 1);
        if (name !== null) modules.push(name);
      }
    } else if (field.no === 8 && field.bytes && meta === null) {
      meta = field.bytes;
    }
  }

  if (!sawModules && meta === null) throw new Error("no modules and no package metadata: not a Substreams package");
  return {
    name: meta ? firstString(meta, 3) : null,
    version: meta ? firstString(meta, 1) : null,
    modules,
  };
}
