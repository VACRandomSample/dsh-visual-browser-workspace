/**
 * Single error shape for every failure: { "error": { "code": string, "message": string } }
 * with a proper HTTP status (broker-api.md).
 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const err = (status, code, message) => new HttpError(status, code, message);

export const badRequest = (message, code = 'BAD_REQUEST') => err(400, code, message);
export const busy = (message = 'session is busy with another operation') => err(409, 'SESSION_BUSY', message);
export const notFound = (message = 'not found', code = 'NOT_FOUND') => err(404, code, message);
export const gone = (message = 'session is closed') => err(410, 'SESSION_CLOSED', message);
