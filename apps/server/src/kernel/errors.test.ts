import { describe, expect, it } from "bun:test";
import { AppError, NotFoundError, SecretsLockedError, ValidationError } from "./errors";

describe("AppError", () => {
  it("carries code, message, and status", () => {
    const e = new AppError("boom", "it broke", 418);
    expect(e.code).toBe("boom");
    expect(e.message).toBe("it broke");
    expect(e.status).toBe(418);
    expect(e.name).toBe("AppError");
  });

  it("defaults message to code and status to 500", () => {
    const e = new AppError("oops");
    expect(e.message).toBe("oops");
    expect(e.status).toBe(500);
  });
});

describe("AppError subclasses", () => {
  it("NotFoundError carries not_found / 404 and names what is missing", () => {
    const e = new NotFoundError("dataset");
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe("not_found");
    expect(e.message).toBe("dataset not found");
    expect(e.status).toBe(404);
    expect(e.name).toBe("NotFoundError");
  });

  it("ValidationError carries validation / 400", () => {
    const e = new ValidationError("org must not be empty");
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe("validation");
    expect(e.message).toBe("org must not be empty");
    expect(e.status).toBe(400);
    expect(e.name).toBe("ValidationError");
  });

  it("SecretsLockedError carries secrets.locked / 401", () => {
    const e = new SecretsLockedError();
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe("secrets.locked");
    expect(e.status).toBe(401);
    expect(e.name).toBe("SecretsLockedError");
  });

  it("all subclasses are instanceof AppError and Error", () => {
    for (const e of [new NotFoundError("x"), new ValidationError("y"), new SecretsLockedError()]) {
      expect(e).toBeInstanceOf(AppError);
      expect(e).toBeInstanceOf(Error);
    }
  });
});
