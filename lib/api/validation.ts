import type { ZodSchema } from "zod";
import { fail } from "./http.ts";
import { validateJsonBodyRequest } from "./request-guards.ts";

type ParseJsonOptions = {
  maxBytes?: number;
  requireJsonContentType?: boolean;
};

export async function parseJsonBody<T>(req: Request, schema: ZodSchema<T>, options?: ParseJsonOptions) {
  const guardFailure = validateJsonBodyRequest(req, options);
  if (guardFailure) {
    return {
      success: false as const,
      response: fail(guardFailure.code, guardFailure.message, guardFailure.status, guardFailure.details)
    };
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return {
      success: false as const,
      response: fail("VALIDATION_ERROR", "Invalid request body.", 400, parsed.error.flatten())
    };
  }

  return {
    success: true as const,
    data: parsed.data
  };
}
