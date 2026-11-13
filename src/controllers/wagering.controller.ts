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
import type { Response } from 'express';
import { Money } from '../domain/money';
import { CreateWalletDto, SubmitWagerDto } from '../dtos/wagering.dto';
import { WageringService } from '../services/wagering.service';

@Controller()
export class WageringController {
  /** Recebe o serviço que executa as operações de carteira e aposta. */
  constructor(private readonly wagering: WageringService) {}

  /** Cria uma carteira com o saldo inicial informado. */
  @Post('wallets')
  createWallet(@Body() body: CreateWalletDto) {
    return this.wagering.createWallet(
      body.playerId,
      Money.from(body.initialBalance),
    );
  }

  /** Consulta o saldo e os dados básicos de uma carteira. */
  @Get('wallets/:walletId')
  getWallet(@Param('walletId') walletId: string) {
    return this.wagering.getWallet(walletId);
  }

  /** Lista os lançamentos da carteira usando cursor e limite opcionais. */
  @Get('wallets/:walletId/ledger')
  getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '50',
  ) {
    return this.wagering.getLedger(walletId, cursor, Number(limit));
  }

  /** Compara o saldo armazenado com o saldo reconstruído pelo ledger. */
  @Post('wallets/:walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId') walletId: string) {
    return this.wagering.reconcile(walletId);
  }

  /** Submete uma aposta idempotente e define o status HTTP conforme o resultado. */
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

  /** Consulta uma transação pelo identificador interno. */
  @Get('wagering/transactions/:transactionId')
  getTransaction(@Param('transactionId') id: string) {
    return this.wagering.getTransaction(id);
  }

  /** Consulta uma transação pelo provedor e identificador externo. */
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
  ) {
    return this.wagering.getProviderTransaction(providerId, externalId);
  }
}
