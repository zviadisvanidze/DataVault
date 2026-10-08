import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { extname } from 'path';
import { CompanyFileType } from './entities/company-file.entity';

export interface UploadedCompanyFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface ValidatedCompanyFile {
  originalFilename: string;
  fileType: CompanyFileType;
  mimeType: string;
  size: number;
  buffer: Buffer;
}

const MIME_TYPES: Record<CompanyFileType, readonly string[]> = {
  [CompanyFileType.CSV]: [
    'text/csv',
    'application/csv',
    'text/plain',
    'application/vnd.ms-excel',
  ],
  [CompanyFileType.XLS]: ['application/vnd.ms-excel'],
  [CompanyFileType.XLSX]: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
};

export const CANONICAL_MIME_TYPES: Record<CompanyFileType, string> = {
  [CompanyFileType.CSV]: 'text/csv',
  [CompanyFileType.XLS]: 'application/vnd.ms-excel',
  [CompanyFileType.XLSX]:
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function validateCompanyFile(
  file: UploadedCompanyFile | undefined,
  maxSizeBytes: number,
): ValidatedCompanyFile {
  if (!file?.buffer || file.size < 1 || file.buffer.length < 1)
    throw new BadRequestException('A non-empty file is required');
  if (file.size !== file.buffer.length)
    throw new BadRequestException('File size is invalid');
  if (file.size > maxSizeBytes)
    throw new PayloadTooLargeException(
      'File exceeds the configured size limit',
    );

  const originalFilename = safeFilename(file.originalname);
  const extension = extname(originalFilename).slice(1).toLowerCase();
  if (!Object.values(CompanyFileType).includes(extension as CompanyFileType))
    throw new BadRequestException('Only CSV, XLS, and XLSX files are allowed');
  const fileType = extension as CompanyFileType;
  const suppliedMime = file.mimetype.trim().toLowerCase();
  if (!MIME_TYPES[fileType].includes(suppliedMime))
    throw new BadRequestException(
      'File MIME type does not match its extension',
    );

  if (fileType === CompanyFileType.CSV) validateCsv(file.buffer);
  if (fileType === CompanyFileType.XLS) validateXls(file.buffer);
  if (fileType === CompanyFileType.XLSX) validateXlsx(file.buffer);

  return {
    originalFilename,
    fileType,
    mimeType: CANONICAL_MIME_TYPES[fileType],
    size: file.size,
    buffer: file.buffer,
  };
}

export function safeFilename(input: string) {
  const leaf = input.normalize('NFC').replace(/\\/g, '/').split('/').at(-1);
  const filename = leaf
    ? [...leaf]
        .filter((character) => {
          const code = character.charCodeAt(0);
          return code >= 32 && code !== 127;
        })
        .join('')
        .trim()
    : undefined;
  if (!filename || filename === '.' || filename === '..')
    throw new BadRequestException('Filename is invalid');
  if (Buffer.byteLength(filename, 'utf8') > 255)
    throw new BadRequestException('Filename is too long');
  return filename;
}

export function contentDisposition(filename: string) {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function validateCsv(buffer: Buffer) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new BadRequestException('CSV file must be valid UTF-8 text');
  }
  const containsInvalidControl = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  });
  if (!text.trim() || containsInvalidControl)
    throw new BadRequestException('CSV file content is invalid');
}

function validateXls(buffer: Buffer) {
  const signature = Buffer.from('d0cf11e0a1b11ae1', 'hex');
  if (
    buffer.length < 512 ||
    !buffer.subarray(0, 8).equals(signature) ||
    buffer.readUInt16LE(28) !== 0xfffe ||
    ![9, 12].includes(buffer.readUInt16LE(30)) ||
    (!buffer.includes(Buffer.from('Workbook\0', 'utf16le')) &&
      !buffer.includes(Buffer.from('Book\0', 'utf16le')))
  )
    throw new BadRequestException('XLS file structure is invalid');
}

function validateXlsx(buffer: Buffer) {
  const zipSignature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  if (buffer.length < 22 || !buffer.subarray(0, 4).equals(zipSignature))
    throw new BadRequestException('XLSX file structure is invalid');

  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  const eocdOffset = buffer.lastIndexOf(eocdSignature);
  if (eocdOffset < minimumOffset || eocdOffset + 22 > buffer.length)
    throw new BadRequestException('XLSX file structure is invalid');
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (
    entryCount < 2 ||
    centralOffset + centralSize > eocdOffset ||
    centralOffset >= buffer.length
  )
    throw new BadRequestException('XLSX file structure is invalid');

  const names = new Set<string>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocdOffset || buffer.readUInt32LE(offset) !== 0x02014b50)
      throw new BadRequestException('XLSX file structure is invalid');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > eocdOffset)
      throw new BadRequestException('XLSX file structure is invalid');
    names.add(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset = nextOffset;
  }
  if (
    offset !== centralOffset + centralSize ||
    !names.has('[Content_Types].xml') ||
    !names.has('xl/workbook.xml')
  )
    throw new BadRequestException('XLSX file structure is invalid');
}
