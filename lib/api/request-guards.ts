type JsonGuardOptions = {
  maxBytes?: number;
  requireJsonContentType?: boolean;
};

export type JsonGuardFailure = {
  code: "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE";
  message: string;
  status: 415 | 413;
  details?: {
    maxBytes?: number;
  };
};

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

export function validateJsonBodyRequest(req: Request, options?: JsonGuardOptions): JsonGuardFailure | null {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const requireJsonContentType = options?.requireJsonContentType ?? true;

  if (requireJsonContentType) {
    const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Content-Type must be application/json.",
        status: 415
      };
    }
  }

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds size limit.",
        status: 413,
        details: {
          maxBytes
        }
      };
    }
  }

  return null;
}
