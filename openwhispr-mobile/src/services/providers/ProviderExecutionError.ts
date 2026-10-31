export class ProviderExecutionError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retryable: boolean;

  public constructor(
    code: string,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'ProviderExecutionError';
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
