import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MetricsService } from '../app/metrics.service';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT,
    credentials: process.env.SQS_ENDPOINT
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' }
      : undefined,
  });
  private stopping = false;
  private loop?: Promise<void>;
  private readonly queueUrl = process.env.OUTBOX_QUEUE_URL ?? '';

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (this.queueUrl) this.loop = this.publishLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.client.destroy();
  }

  private async publishLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const claimed = await this.claimBatch();
        if (claimed.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        for (const row of claimed) {
          if (this.stopping) break;
          try {
            await this.client.send(new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody: JSON.stringify(row.payload),
              MessageGroupId: row.aggregate_id,
              MessageDeduplicationId: row.id,
            }));
            await this.dataSource.query(
              `UPDATE outbox_messages
               SET published_at = now(), lease_until = NULL
               WHERE id = $1`,
              [row.id],
            );
          } catch (error) {
            this.metrics.increment('wager_outbox_retries_total');
            const retryDelay = Math.min(300, 2 ** Math.min(row.attempts, 8));
            await this.dataSource.query(
              `UPDATE outbox_messages
               SET attempts = attempts + 1,
                   next_attempt_at = now() + ($2 * interval '1 second'),
                   lease_until = NULL
               WHERE id = $1`,
              [row.id, retryDelay],
            );
            console.error(JSON.stringify({
              event: 'outbox_publish_failed',
              eventId: row.id,
              attempt: row.attempts + 1,
              message: error instanceof Error ? error.message : 'unknown',
            }));
          }
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'outbox_worker_error',
          message: error instanceof Error ? error.message : 'unknown',
        }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async claimBatch(): Promise<OutboxRow[]> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const rows = await runner.query(
        `SELECT id, aggregate_id, payload, attempts
         FROM outbox_messages
         WHERE published_at IS NULL
           AND next_attempt_at <= now()
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY occurred_at
         FOR UPDATE SKIP LOCKED
         LIMIT 10`,
      ) as OutboxRow[];
      const lag = await runner.query(
        `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(occurred_at))), 0)::float8 AS seconds
         FROM outbox_messages WHERE published_at IS NULL`,
      ) as Array<{ seconds: number }>;
      this.metrics.setGauge('wager_outbox_lag_seconds', Number(lag[0]?.seconds ?? 0));
      if (rows.length) {
        await runner.query(
          `UPDATE outbox_messages SET lease_until = now() + interval '30 seconds'
           WHERE id = ANY($1::uuid[])`,
          [rows.map((row) => row.id)],
        );
      }
      await runner.commitTransaction();
      return rows;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
