import { HttpException, HttpStatus } from '@nestjs/common';

export class DomainHttpError extends HttpException {
  constructor(
    readonly code: string,
    status: HttpStatus,
  ) {
    super({ code }, status);
  }
}
