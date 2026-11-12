import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DatabaseLifecycle implements BeforeApplicationShutdown {
  constructor(private readonly dataSource: DataSource) {}

  async beforeApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
