// Reads and rewrites DLL module names in a PE image's import and delay-load
// directories. Used by download-sherpa-onnx.js to point the bundled sherpa
// binaries at a privately named ONNX Runtime, because Windows 11 ships an
// older onnxruntime.dll in System32 and some loader configurations pick it
// over the application directory (#2054). Names are patched in place, so a
// replacement can never be longer than the original.
const DOS_MAGIC = 0x5a4d; // "MZ"
const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const OPTIONAL_HEADER_PE32 = 0x10b;
const OPTIONAL_HEADER_PE32_PLUS = 0x20b;
const IMPORT_DIRECTORY_INDEX = 1;
const DELAY_IMPORT_DIRECTORY_INDEX = 13;
const IMPORT_DESCRIPTOR_SIZE = 20;
const DELAY_DESCRIPTOR_SIZE = 32;
const SECTION_HEADER_SIZE = 40;
const MAX_MODULE_NAME_LENGTH = 256;

function parseHeaders(image) {
  if (image.length < 0x40 || image.readUInt16LE(0) !== DOS_MAGIC) {
    throw new Error("not a PE image: missing MZ header");
  }
  const peOffset = image.readUInt32LE(0x3c);
  if (peOffset + 24 > image.length || image.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error("not a PE image: missing PE signature");
  }

  const numberOfSections = image.readUInt16LE(peOffset + 6);
  const sizeOfOptionalHeader = image.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const magic = image.readUInt16LE(optionalOffset);

  let numberOfRvaAndSizes;
  let dataDirectoryOffset;
  if (magic === OPTIONAL_HEADER_PE32) {
    numberOfRvaAndSizes = image.readUInt32LE(optionalOffset + 92);
    dataDirectoryOffset = optionalOffset + 96;
  } else if (magic === OPTIONAL_HEADER_PE32_PLUS) {
    numberOfRvaAndSizes = image.readUInt32LE(optionalOffset + 108);
    dataDirectoryOffset = optionalOffset + 112;
  } else {
    throw new Error(`unsupported optional header magic 0x${magic.toString(16)}`);
  }

  const sectionTableOffset = optionalOffset + sizeOfOptionalHeader;
  const sections = [];
  for (let index = 0; index < numberOfSections; index += 1) {
    const header = sectionTableOffset + index * SECTION_HEADER_SIZE;
    sections.push({
      virtualSize: image.readUInt32LE(header + 8),
      virtualAddress: image.readUInt32LE(header + 12),
      sizeOfRawData: image.readUInt32LE(header + 16),
      pointerToRawData: image.readUInt32LE(header + 20),
    });
  }

  const directory = (index) => {
    if (index >= numberOfRvaAndSizes) return null;
    const entry = dataDirectoryOffset + index * 8;
    const virtualAddress = image.readUInt32LE(entry);
    return virtualAddress === 0 ? null : { virtualAddress, size: image.readUInt32LE(entry + 4) };
  };

  return { sections, directory };
}

function rvaToOffset(rva, sections) {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.sizeOfRawData);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return rva - section.virtualAddress + section.pointerToRawData;
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
}

function readModuleName(image, offset) {
  const end = image.indexOf(0, offset);
  if (end === -1 || end - offset > MAX_MODULE_NAME_LENGTH) {
    throw new Error(`unterminated module name at offset 0x${offset.toString(16)}`);
  }
  return image.toString("ascii", offset, end);
}

// Yields { offset, name } for every module-name string referenced from the
// import directory, then from the delay-load directory.
function* moduleNameEntries(image) {
  const { sections, directory } = parseHeaders(image);

  const imports = directory(IMPORT_DIRECTORY_INDEX);
  if (imports) {
    let descriptor = rvaToOffset(imports.virtualAddress, sections);
    for (;;) {
      const originalFirstThunk = image.readUInt32LE(descriptor);
      const nameRva = image.readUInt32LE(descriptor + 12);
      const firstThunk = image.readUInt32LE(descriptor + 16);
      if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break;
      const offset = rvaToOffset(nameRva, sections);
      yield { offset, name: readModuleName(image, offset) };
      descriptor += IMPORT_DESCRIPTOR_SIZE;
    }
  }

  const delayed = directory(DELAY_IMPORT_DIRECTORY_INDEX);
  if (delayed) {
    let descriptor = rvaToOffset(delayed.virtualAddress, sections);
    for (;;) {
      const attributes = image.readUInt32LE(descriptor);
      const nameRva = image.readUInt32LE(descriptor + 4);
      if (attributes === 0 && nameRva === 0) break;
      if ((attributes & 1) === 0) {
        // Pre-VS2010 descriptors store virtual addresses; nothing we ship uses them.
        throw new Error("delay-load descriptor is not RVA-based; refusing to patch");
      }
      const offset = rvaToOffset(nameRva, sections);
      yield { offset, name: readModuleName(image, offset) };
      descriptor += DELAY_DESCRIPTOR_SIZE;
    }
  }
}

function listImportedModules(image) {
  return [...moduleNameEntries(image)].map((entry) => entry.name);
}

function renameImportedModule(image, fromName, toName) {
  if (Buffer.byteLength(toName, "ascii") > Buffer.byteLength(fromName, "ascii")) {
    throw new Error(
      `replacement "${toName}" is longer than "${fromName}"; import names are patched in place and cannot grow`
    );
  }
  const target = fromName.toLowerCase();
  const patchedOffsets = new Set();
  for (const { offset, name } of moduleNameEntries(image)) {
    if (name.toLowerCase() !== target || patchedOffsets.has(offset)) continue;
    image.fill(0, offset, offset + name.length);
    image.write(toName, offset, "ascii");
    patchedOffsets.add(offset);
  }
  return patchedOffsets.size;
}

module.exports = { listImportedModules, renameImportedModule };
