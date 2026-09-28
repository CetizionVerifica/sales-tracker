import { DomainError } from '../errors.ts';

/** Extension → mime type accepted for upload (M10b "any format"). */
export const IMPORT_FILE_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
};

export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BYTES = MAX_IMPORT_FILE_BYTES;
const ZIP_MAGIC = [0x50, 0x4b]; // xlsx/xlsm/ods are zip containers ("PK..")
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // legacy .xls

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, i) => bytes[i] === byte);
}

export interface ImportUploadFile {
  bytes: Uint8Array;
  filename: string;
}

/**
 * Extension-gated (spreadsheets have too many valid mime types to allowlist by content
 * type alone), with a magic-byte check for the binary formats so a renamed non-spreadsheet
 * file is still caught (M10b Security). Text formats (csv/tsv/txt) have no reliable magic
 * bytes — `parseWorkbook` catching a garbled read is the backstop for those.
 */
export function assertImportFileAcceptable(file: ImportUploadFile): {
  extension: string;
  mimeType: string;
} {
  if (file.bytes.length === 0) throw new DomainError('The file is empty', { field: 'file' });
  if (file.bytes.length > MAX_BYTES)
    throw new DomainError('The file is larger than 20 MB', { field: 'file' });

  const extension = (file.filename.split('.').pop() ?? '').toLowerCase();
  const mimeType = IMPORT_FILE_TYPES[extension];
  if (!mimeType) {
    throw new DomainError('Upload a .xlsx, .xlsm, .xls, .ods, .csv, .tsv or .txt file', {
      field: 'file',
    });
  }

  if (['xlsx', 'xlsm', 'ods'].includes(extension) && !startsWith(file.bytes, ZIP_MAGIC)) {
    throw new DomainError('The file’s contents do not match its extension', { field: 'file' });
  }
  if (extension === 'xls' && !startsWith(file.bytes, OLE_MAGIC)) {
    throw new DomainError('The file’s contents do not match its extension', { field: 'file' });
  }

  return { extension, mimeType };
}
