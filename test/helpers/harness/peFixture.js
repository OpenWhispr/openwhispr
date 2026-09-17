// Minimal PE32+ images for exercising scripts/lib/pe-imports.js without real
// Windows binaries. One .rdata section holds the import descriptors, the
// delay-load descriptors and the module name strings, which is all the
// reader looks at.
const IMPORT_DESCRIPTOR_SIZE = 20;
const DELAY_DESCRIPTOR_SIZE = 32;
const PE_HEADER_OFFSET = 0x80;
const OPTIONAL_HEADER_SIZE = 240; // PE32+
const SECTION_RVA = 0x1000;
const SECTION_FILE_OFFSET = 0x400;
const FILE_ALIGNMENT = 0x200;

function buildPeImage({ imports = [], delayImports = [] } = {}) {
  const importTableSize = (imports.length + 1) * IMPORT_DESCRIPTOR_SIZE;
  const delayTableSize =
    delayImports.length > 0 ? (delayImports.length + 1) * DELAY_DESCRIPTOR_SIZE : 0;

  // Name strings follow the two tables inside the section.
  const nameOffsets = new Map();
  let cursor = importTableSize + delayTableSize;
  const nameBlobs = [];
  for (const name of [...imports, ...delayImports]) {
    nameOffsets.set(name, cursor);
    nameBlobs.push(Buffer.from(`${name}\0`, "ascii"));
    cursor += name.length + 1;
  }
  const sectionSize = Math.max(FILE_ALIGNMENT, Math.ceil(cursor / FILE_ALIGNMENT) * FILE_ALIGNMENT);
  const image = Buffer.alloc(SECTION_FILE_OFFSET + sectionSize);

  // DOS header
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(PE_HEADER_OFFSET, 0x3c); // e_lfanew

  // PE signature + COFF file header
  image.writeUInt32LE(0x00004550, PE_HEADER_OFFSET); // "PE\0\0"
  image.writeUInt16LE(0x8664, PE_HEADER_OFFSET + 4); // Machine: x64
  image.writeUInt16LE(1, PE_HEADER_OFFSET + 6); // NumberOfSections
  image.writeUInt16LE(OPTIONAL_HEADER_SIZE, PE_HEADER_OFFSET + 20);

  // Optional header (PE32+)
  const optional = PE_HEADER_OFFSET + 24;
  image.writeUInt16LE(0x20b, optional); // Magic
  image.writeUInt32LE(16, optional + 108); // NumberOfRvaAndSizes
  const dataDirectory = (index) => optional + 112 + index * 8;
  image.writeUInt32LE(SECTION_RVA, dataDirectory(1));
  image.writeUInt32LE(importTableSize, dataDirectory(1) + 4);
  if (delayTableSize > 0) {
    image.writeUInt32LE(SECTION_RVA + importTableSize, dataDirectory(13));
    image.writeUInt32LE(delayTableSize, dataDirectory(13) + 4);
  }

  // Section header
  const section = optional + OPTIONAL_HEADER_SIZE;
  image.write(".rdata", section, "ascii");
  image.writeUInt32LE(cursor, section + 8); // VirtualSize
  image.writeUInt32LE(SECTION_RVA, section + 12); // VirtualAddress
  image.writeUInt32LE(sectionSize, section + 16); // SizeOfRawData
  image.writeUInt32LE(SECTION_FILE_OFFSET, section + 20); // PointerToRawData

  // IMAGE_IMPORT_DESCRIPTOR entries (terminated by an all-zero entry)
  imports.forEach((name, index) => {
    const descriptor = SECTION_FILE_OFFSET + index * IMPORT_DESCRIPTOR_SIZE;
    image.writeUInt32LE(SECTION_RVA + nameOffsets.get(name), descriptor + 12); // Name
    image.writeUInt32LE(0x2000, descriptor + 16); // FirstThunk (unused by the reader)
  });

  // IMAGE_DELAYLOAD_DESCRIPTOR entries (RVA-based, terminated by an all-zero entry)
  delayImports.forEach((name, index) => {
    const descriptor = SECTION_FILE_OFFSET + importTableSize + index * DELAY_DESCRIPTOR_SIZE;
    image.writeUInt32LE(1, descriptor); // Attributes: RvaBased
    image.writeUInt32LE(SECTION_RVA + nameOffsets.get(name), descriptor + 4); // DllNameRVA
  });

  Buffer.concat(nameBlobs).copy(image, SECTION_FILE_OFFSET + importTableSize + delayTableSize);
  return image;
}

module.exports = { buildPeImage };
