import type { ZodSchema } from "zod";
import { fail } from "./http";

export async function parseJsonBody<T>(req: Request, schema: ZodSchema<T>) {
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
