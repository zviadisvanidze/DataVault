import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { CompanyFileType } from './entities/company-file.entity';
import {
  contentDisposition,
  UploadedCompanyFile,
  validateCompanyFile,
} from './file-validation';

const maxSize = 1024;
const upload = (
  originalname: string,
  mimetype: string,
  buffer: Buffer,
): UploadedCompanyFile => ({
  originalname,
  mimetype,
  buffer,
  size: buffer.length,
});

function validXls() {
  const buffer = Buffer.alloc(512);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(buffer);
  buffer.writeUInt16LE(0xfffe, 28);
  buffer.writeUInt16LE(9, 30);
  Buffer.from('Workbook\0', 'utf16le').copy(buffer, 128);
  return buffer;
}

function validXlsx() {
  return minimalZip(['[Content_Types].xml', 'xl/workbook.xml']);
}

function minimalZip(names: string[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const value of names) {
    const name = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length;
  }
  const localData = Buffer.concat(localParts);
  const centralData = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralData.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, eocd]);
}

describe('company file validation', () => {
  it.each([
    [
      'data.csv',
      'text/csv',
      Buffer.from('name,value\nfirst,1\n'),
      CompanyFileType.CSV,
    ],
    ['legacy.xls', 'application/vnd.ms-excel', validXls(), CompanyFileType.XLS],
    [
      'book.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      validXlsx(),
      CompanyFileType.XLSX,
    ],
  ])('accepts a valid %s upload', (name, mime, buffer, expectedType) => {
    expect(
      validateCompanyFile(upload(name, mime, buffer), maxSize),
    ).toMatchObject({
      originalFilename: name,
      fileType: expectedType,
      size: buffer.length,
    });
  });

  it('normalizes path-like filenames and produces a safe download header', () => {
    const file = validateCompanyFile(
      upload('..\\folder/ report.csv ', 'text/csv', Buffer.from('a,b\n1,2')),
      maxSize,
    );
    expect(file.originalFilename).toBe('report.csv');
    expect(contentDisposition('résumé "final".csv')).not.toMatch(/[\r\n]/);
    expect(contentDisposition('résumé "final".csv')).toContain(
      "filename*=UTF-8''",
    );
  });

  it.each([
    ['empty file', upload('data.csv', 'text/csv', Buffer.alloc(0))],
    [
      'unsupported MIME',
      upload('data.csv', 'application/octet-stream', Buffer.from('a,b')),
    ],
    [
      'unsupported extension',
      upload('data.pdf', 'application/pdf', Buffer.from('x')),
    ],
    ['mismatched MIME', upload('data.xlsx', 'text/csv', validXlsx())],
    ['binary CSV', upload('data.csv', 'text/csv', Buffer.from([0, 1, 2]))],
    [
      'spoofed XLS',
      upload('data.xls', 'application/vnd.ms-excel', Buffer.alloc(512)),
    ],
    [
      'spoofed XLSX',
      upload(
        'data.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        Buffer.concat([
          Buffer.from([0x50, 0x4b, 0x03, 0x04]),
          Buffer.alloc(20),
        ]),
      ),
    ],
  ])('rejects an invalid upload: %s', (_label, file) => {
    expect(() => validateCompanyFile(file, maxSize)).toThrow(
      BadRequestException,
    );
  });

  it('rejects files over the configured maximum', () => {
    expect(() =>
      validateCompanyFile(
        upload('data.csv', 'text/csv', Buffer.from('a,b\n1,2')),
        2,
      ),
    ).toThrow(PayloadTooLargeException);
  });
});
