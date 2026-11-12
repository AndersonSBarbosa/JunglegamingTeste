import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { wagerKinds } from '../domain/wager';

export class MoneyDto {
  @IsString()
  @Matches(/^(0|[1-9]\d*)\.\d{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class CreateWalletDto {
  @IsString()
  @IsNotEmpty()
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  @IsDefined()
  initialBalance!: MoneyDto;
}

export class SubmitWagerDto {
  @IsString() @IsNotEmpty() providerId!: string;
  @IsString() @IsNotEmpty() externalTransactionId!: string;
  @IsString() @IsNotEmpty() playerId!: string;
  @IsString() @IsNotEmpty() walletId!: string;
  @IsString() @IsNotEmpty() roundId!: string;
  @IsString() @IsNotEmpty() gameId!: string;

  @IsIn(wagerKinds)
  kind!: (typeof wagerKinds)[number];

  @ValidateNested()
  @Type(() => MoneyDto)
  @IsDefined()
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}
