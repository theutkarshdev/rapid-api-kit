/**
 * Express middleware for error handling and 404s
 */

function notFoundHandler(req, res, next) {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
    hint: "Visit / to see all available endpoints, or /api/docs for Swagger documentation.",
  });
}

function errorHandler(err, req, res, next) {
  console.error("❌ [rapid-api-kit] Error:", err.message);

  // Mongoose CastError (bad ObjectId, etc.)
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      error: `Invalid ${err.path}: ${err.value}`,
    });
  }

  // JSON parse error
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON in request body",
    });
  }

  // Default server error
  res.status(err.status || 500).json({
    success: false,
    error: err.message || "Internal server error",
  });
}

module.exports = { notFoundHandler, errorHandler };
