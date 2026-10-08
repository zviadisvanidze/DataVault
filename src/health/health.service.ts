import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, ConnectionStates } from 'mongoose';

@Injectable()
export class HealthService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async readiness() {
    if (
      this.connection.readyState !== ConnectionStates.connected ||
      !this.connection.db
    )
      throw this.unavailable();
    try {
      await this.connection.db.admin().ping();
      return { status: 'ok', dependencies: { mongodb: 'up' } };
    } catch {
      throw this.unavailable();
    }
  }

  private unavailable() {
    return new ServiceUnavailableException({
      status: 'unavailable',
      dependencies: { mongodb: 'down' },
    });
  }
}
