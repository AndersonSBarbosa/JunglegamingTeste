import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DatabaseLifecycle } from '../database/database-lifecycle';
import {
  NoopProviderIdentityAdapter,
  ProviderIdentityPort,
} from '../auth/provider-identity.port';
import { MetricsService } from './metrics.service';
import { dataSource } from '../database/data-source';
import { OutboxPublisher } from '../messaging/outbox.publisher';
import { SqsConsumer } from '../messaging/sqs.service';
import { WageringController } from '../wagering/wagering.controller';
import { WageringService } from '../wagering/wagering.service';
import { HealthController } from './health.controller';

@Module({
  controllers: [WageringController, HealthController],
  providers: [
    {
      provide: DataSource,
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
