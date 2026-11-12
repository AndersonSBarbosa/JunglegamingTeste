import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { SqsConsumer } from '../messaging/sqs.service';
import { MetricsService } from './metrics.service';

@Controller()
export class HealthController {
  constructor(
    private readonly sqs: SqsConsumer,
    private readonly metrics: MetricsService,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('metrics')
  metricsText(@Res({ passthrough: true }) response: Response) {
    response.type('text/plain; version=0.0.4');
    return this.metrics.render();
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [database, queue] = await Promise.all([
      this.sqs.isDatabaseReachable(),
      this.sqs.isReachable(),
    ]);
    const ready = database && queue;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable', database, queue };
  }

}
