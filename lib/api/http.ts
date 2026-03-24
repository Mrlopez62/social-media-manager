import { NextResponse } from "next/server.js";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status });
}

export function fail(
  code: string,
  message: string,
  status = 400,
  details?: unknown,
  headers?: HeadersInit
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        details: details ?? null
      }
    },
    { status, headers }
  );
}
