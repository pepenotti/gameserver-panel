import type { OrchestratorError, OrchestratorErrorCode } from '@gsp/shared';

const STATUS: Record<OrchestratorErrorCode, number> = {
  unauthorized: 401,
  'bad-request': 400,
  refused: 403,
  'not-found': 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

/** An answer the API gives on purpose: it becomes an `OrchestratorError` body. */
export class OrchError extends Error {
  readonly status: number;

  constructor(
    readonly code: OrchestratorErrorCode,
    message: string,
    readonly field?: string,
    status?: number,
  ) {
    super(message);
    this.status = status ?? STATUS[code];
  }

  body(): OrchestratorError {
    return this.field === undefined ? { error: this.message, code: this.code } : { error: this.message, code: this.code, field: this.field };
  }
}

/** The spec asks for something outside the allowlist (NFR-02). */
export const refused = (field: string, message: string) => new OrchError('refused', message, field);
export const badRequest = (message: string, field?: string) => new OrchError('bad-request', message, field);
export const conflict = (message: string, field?: string) => new OrchError('conflict', message, field);
export const notFound = (message: string) => new OrchError('not-found', message);
export const unavailable = (message: string) => new OrchError('unavailable', message);
