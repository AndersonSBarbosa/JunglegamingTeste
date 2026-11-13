import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DatabaseLifecycle implements BeforeApplicationShutdown {
  /** Recebe a conexão que será encerrada durante o desligamento. */
  constructor(private readonly dataSource: DataSource) {}

  /** Fecha a conexão do banco quando a aplicação termina. */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
