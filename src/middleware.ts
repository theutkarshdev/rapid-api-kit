import type { Request, Response, NextFunction } from "express";

/**
 * Express middleware for error handling and 404s
 */

function notFoundHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
    hint: "Visit / to see all available endpoints, or /api/docs for Swagger documentation.",
  });
}

interface AppError extends Error {
  status?: number;
  type?: string;
  path?: string;
  value?: unknown;
}

function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error("❌ [rapid-api-kit] Error:", err.message);

  // Mongoose CastError (bad ObjectId, etc.)
  if (err.name === "CastError") {
    res.status(400).json({
      success: false,
      error: `Invalid ${err.path}: ${err.value}`,
    });
    return;
  }

  // JSON parse error
  if (err.type === "entity.parse.failed") {
    res.status(400).json({
      success: false,
      error: "Invalid JSON in request body",
    });
    return;
  }

  // Default server error
  res.status(err.status || 500).json({
    success: false,
    error: err.message || "Internal server error",
  });
}

export { notFoundHandler, errorHandler };
