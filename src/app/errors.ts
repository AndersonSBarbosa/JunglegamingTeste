import { HttpException, HttpStatus } from '@nestjs/common';

export class DomainHttpError extends HttpException {
  /** Cria uma resposta HTTP padronizada com código de erro de domínio. */
  constructor(
    readonly code: string,
    status: HttpStatus,
  ) {
    super({ code }, status);
  }
}
