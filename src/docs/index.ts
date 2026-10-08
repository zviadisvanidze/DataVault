import { INestApplication } from '@nestjs/common';
import { applyOpenApiMetadata } from './openapi-metadata';
import { buildOpenApiDocument, setupSwagger } from './swagger';

export function createOpenApiDocument(app: INestApplication) {
  applyOpenApiMetadata();
  return buildOpenApiDocument(app);
}

export function configureSwagger(app: INestApplication) {
  applyOpenApiMetadata();
  return setupSwagger(app);
}
