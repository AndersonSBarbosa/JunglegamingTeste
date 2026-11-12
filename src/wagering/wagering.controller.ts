import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { Money } from '../domain/money';
import { CreateWalletDto, SubmitWagerDto } from './wagering.dto';
import { WageringService } from './wagering.service';

@Controller()
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post('wallets')
  createWallet(@Body() body: CreateWalletDto) {
    return this.wagering.createWallet(
      body.playerId,
      Money.from(body.initialBalance),
    );
  }

  @Get('wallets/:walletId')
  getWallet(@Param('walletId') walletId: string) {
    return this.wagering.getWallet(walletId);
  }

  @Get('wallets/:walletId/ledger')
  getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '50',
  ) {
    return this.wagering.getLedger(walletId, cursor, Number(limit));
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId') walletId: string) {
    return this.wagering.reconcile(walletId);
  }

  @Post('wagering/transactions')
  async submit(
    @Body() body: SubmitWagerDto,
    @Headers('idempotency-key') key?: string,
    @Res({ passthrough: true }) response?: Response,
  ) {
    const result = await this.wagering.process(body, key ?? '');
    if (response) {
      response.status(
        result.status === 'PENDING_REFERENCE' ? HttpStatus.ACCEPTED :
          result.status === 'REJECTED' ? HttpStatus.UNPROCESSABLE_ENTITY :
            HttpStatus.OK,
      );
    }
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  getTransaction(@Param('transactionId') id: string) {
    return this.wagering.getTransaction(id);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
  ) {
    return this.wagering.getProviderTransaction(providerId, externalId);
  }
}
