import {
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  HttpException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MetricsService } from './metrics.service';
import { WagerInput } from '../domain/wager';
import { WageringService } from './wagering.service';

interface WagerMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  data: WagerInput & { idempotencyKey: string };
}

@Injectable()
export class SqsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly client: SQSClient;
  private stopping = false;
  private loop?: Promise<void>;
  private readonly queueUrl = process.env.SQS_QUEUE_URL ?? '';
  private readonly enabled = process.env.SQS_ENABLED !== 'false';

  /** Configura o cliente SQS e recebe os serviços usados pelo consumidor. */
  constructor(
    private readonly wagering: WageringService,
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
  ) {
    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT,
      credentials: process.env.SQS_ENDPOINT
        ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' }
        : undefined,
    });
  }

  /** Inicia a leitura da fila quando o consumidor está habilitado e configurado. */
  onModuleInit(): void {
    if (this.enabled && this.queueUrl) this.loop = this.poll();
  }

  /** Para o loop de consumo e libera os recursos do cliente SQS. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.client.destroy();
  }

  /** Verifica se a fila SQS configurada pode ser consultada. */
  async isReachable(): Promise<boolean> {
    if (!this.enabled || !this.queueUrl) return true;
    try {
      await this.client.send(new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: ['QueueArn'],
      }));
      return true;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'sqs_readiness_failed',
        message: error instanceof Error ? error.message : 'unknown',
      }));
      return false;
    }
  }

  /** Atualiza o gauge com a quantidade aproximada de mensagens na DLQ. */
  async updateDlqMetric(): Promise<void> {
    const dlqUrl = process.env.SQS_DLQ_URL;
    if (!dlqUrl) return;
    try {
      const response = await this.client.send(new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      this.metrics.setGauge(
        'wager_messages_dlq',
        Number(response.Attributes?.ApproximateNumberOfMessages ?? 0),
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: 'dlq_metric_failed',
        message: error instanceof Error ? error.message : 'unknown',
      }));
    }
  }

  /** Recebe mensagens, processa cada uma e só então confirma sua remoção. */
  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const response = await this.client.send(new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 10,
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));
        for (const message of response.Messages ?? []) {
          if (!message.Body || !message.ReceiptHandle || !message.MessageId) continue;
          if (this.stopping) {
            await this.client.send(new ChangeMessageVisibilityCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }));
            break;
          }
          try {
            await this.consume(message.Body, message.MessageId);
          } catch (error) {
            if (error instanceof HttpException &&
                error.getStatus() >= 400 && error.getStatus() < 500) {
              this.metrics.increment('wager_consumer_rejected_total');
              console.error(JSON.stringify({
                event: 'sqs_message_rejected',
                messageId: message.MessageId,
                status: error.getStatus(),
              }));
            } else {
              throw error;
            }
          }
          await this.client.send(new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }));
        }
      } catch (error) {
        this.metrics.increment('wager_consumer_retries_total');
        console.error(JSON.stringify({
          event: 'sqs_consumer_error',
          message: error instanceof Error ? error.message : 'unknown',
        }));
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      await this.updateDlqMetric();
    }
  }

  /** Valida o envelope recebido e encaminha a transação ao caso de uso comum. */
  private async consume(body: string, messageId: string): Promise<void> {
    let message: WagerMessage;
    try {
      message = JSON.parse(body) as WagerMessage;
    } catch {
      throw new Error('INVALID_SQS_MESSAGE_JSON');
    }
    if (message.type !== 'WagerTransactionRequested' ||
        !message.data?.idempotencyKey) {
      throw new Error('INVALID_SQS_MESSAGE');
    }
    await this.wagering.process(
      message.data,
      message.data.idempotencyKey,
      { messageId, consumerName: 'wager-processor' },
    );
  }

  /** Executa uma consulta simples para verificar a disponibilidade do PostgreSQL. */
  async isDatabaseReachable(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch (error) {
      console.error(JSON.stringify({
        event: 'database_readiness_failed',
        message: error instanceof Error ? error.message : 'unknown',
      }));
      return false;
    }
  }
}
