import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DatabaseLifecycle } from '../database/database-lifecycle';
import {
  NoopProviderIdentityAdapter,
  ProviderIdentityPort,
} from '../auth/provider-identity.port';
import { dataSource } from '../database/data-source';
import { HealthController } from '../controllers/health.controller';
import { WageringController } from '../controllers/wagering.controller';
import { OutboxPublisher } from '../services/outbox.publisher';
import { MetricsService } from '../services/metrics.service';
import { SqsConsumer } from '../services/sqs.service';
import { WageringService } from '../services/wagering.service';

@Module({
  controllers: [WageringController, HealthController],
  providers: [
    {
      provide: DataSource,
      // Abre a conexão e aplica migrations antes de disponibilizar os serviços.
      useFactory: async () => {
        if (!dataSource.isInitialized) {
          await dataSource.initialize();
          await dataSource.runMigrations({ transaction: 'all' });
        }
        return dataSource;
      },
    },
    WageringService,
    SqsConsumer,
    OutboxPublisher,
    MetricsService,
    DatabaseLifecycle,
    {
      provide: ProviderIdentityPort,
      useClass: NoopProviderIdentityAdapter,
    },
  ],
})
export class AppModule {}
