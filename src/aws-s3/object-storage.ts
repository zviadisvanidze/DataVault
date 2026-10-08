import { Readable } from 'stream';

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface StoredObject {
  stream: Readable;
  contentLength?: number;
}

export abstract class ObjectStorage {
  abstract putObject(input: PutObjectInput): Promise<void>;
  abstract getObject(key: string): Promise<StoredObject>;
  abstract deleteObject(key: string): Promise<void>;
}
