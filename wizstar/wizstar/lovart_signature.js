import fs from 'fs';

let wasm;
let dataViewCache = null;
let uint8Cache = null;
let vectorLength = 0;
let decodedLength = 0;
let textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
const textEncoder = new TextEncoder();
textDecoder.decode();

function dataView() {
  if (dataViewCache === null || dataViewCache.buffer !== wasm.memory.buffer) {
    dataViewCache = new DataView(wasm.memory.buffer);
  }
  return dataViewCache;
}

function memoryBytes() {
  if (uint8Cache === null || uint8Cache.byteLength === 0 || uint8Cache.buffer !== wasm.memory.buffer) {
    uint8Cache = new Uint8Array(wasm.memory.buffer);
  }
  return uint8Cache;
}

function passString(value) {
  let length = value.length;
  let pointer = wasm.__wbindgen_export2(length, 1) >>> 0;
  const bytes = memoryBytes();
  let offset = 0;

  for (; offset < length; offset += 1) {
    const code = value.charCodeAt(offset);
    if (code > 0x7f) break;
    bytes[pointer + offset] = code;
  }

  if (offset !== length) {
    if (offset !== 0) value = value.slice(offset);
    pointer = wasm.__wbindgen_export3(pointer, length, length = offset + value.length * 3, 1) >>> 0;
    const view = memoryBytes().subarray(pointer + offset, pointer + length);
    const result = textEncoder.encodeInto(value, view);
    offset += result.written;
    pointer = wasm.__wbindgen_export3(pointer, length, offset, 1) >>> 0;
  }

  vectorLength = offset;
  return pointer;
}

function readString(pointer, length) {
  pointer >>>= 0;
  decodedLength += length;
  if (decodedLength >= 0x7ff00000) {
    textDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
    textDecoder.decode();
    decodedLength = length;
  }
  return textDecoder.decode(memoryBytes().subarray(pointer, pointer + length));
}

function wasmStringCall(name) {
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  let resultPointer = 0;
  let resultLength = 0;
  try {
    wasm[name](retptr);
    resultPointer = dataView().getInt32(retptr + 0, true);
    resultLength = dataView().getInt32(retptr + 4, true);
    return readString(resultPointer, resultLength);
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
    if (resultPointer) wasm.__wbindgen_export(resultPointer, resultLength, 1);
  }
}

function sign(timestamp, reqUuid, arg3, arg4) {
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  let resultPointer = 0;
  let resultLength = 0;
  try {
    const p0 = passString(timestamp);
    const l0 = vectorLength;
    const p1 = passString(reqUuid);
    const l1 = vectorLength;
    const p2 = passString(arg3);
    const l2 = vectorLength;
    const p3 = passString(arg4);
    const l3 = vectorLength;

    wasm.gs(retptr, p0, l0, p1, l1, p2, l2, p3, l3);
    resultPointer = dataView().getInt32(retptr + 0, true);
    resultLength = dataView().getInt32(retptr + 4, true);
    return readString(resultPointer, resultLength);
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
    if (resultPointer) wasm.__wbindgen_export(resultPointer, resultLength, 1);
  }
}

async function main() {
  const [wasmPath, timestamp, reqUuid, arg3 = '', arg4 = ''] = process.argv.slice(2);
  if (!wasmPath || !timestamp || !reqUuid) {
    throw new Error('usage: node lovart_signature.js <wasm> <timestamp> <req_uuid> [arg3] [arg4]');
  }
  const result = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
  wasm = result.instance ? result.instance.exports : result.exports;

  if (arg3 === '__api_secret__') {
    process.stdout.write(wasmStringCall('get_api_secret'));
    return;
  }
  if (arg3 === '__config_secret__') {
    process.stdout.write(wasmStringCall('get_config_secret'));
    return;
  }
  process.stdout.write(sign(timestamp, reqUuid, arg3, arg4));
}

main().catch((error) => {
  process.stderr.write(error && error.stack ? error.stack : String(error));
  process.exit(1);
});