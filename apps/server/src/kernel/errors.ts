export class AppError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
    public readonly status: number = 500,
  ) {
    super(message ?? code);
    this.name = new.target.name;
  }
}
export class NotFoundError extends AppError {
  constructor(what: string) {
    super("not_found", `${what} not found`, 404);
  }
}
export class ValidationError extends AppError {
  constructor(message: string) {
    super("validation", message, 400);
  }
}
export class SecretsLockedError extends AppError {
  constructor() {
    super("secrets.locked", "secret store is locked — log in first", 401);
  }
}
