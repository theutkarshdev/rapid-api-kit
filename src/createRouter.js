const express = require("express");

/**
 * Creates a full CRUD router for a given Mongoose model
 *
 * Generates:
 *  GET    /            → List all (with pagination, filtering, sorting)
 *  GET    /:id         → Get one by ID
 *  POST   /            → Create new
 *  PUT    /:id         → Full update (replace)
 *  PATCH  /:id         → Partial update
 *  DELETE /:id         → Delete by ID
 */
function createRouter(Model, resourceName, options = {}) {
  const router = express.Router();
  const { searchBy = [], filterBy = [] } = options;

  // Helper: check if a field is allowed for filtering
  const isFilterable = (field) => {
    if (filterBy.length === 0) return true; // no restriction if filterBy not specified
    return filterBy.includes(field);
  };

  // ── GET / — List all with pagination, filtering, sorting & search ─
  router.get("/", async (req, res, next) => {
    try {
      const {
        page = 1,
        limit = 10,
        sort = "-createdAt",
        fields,
        search,
        ...filters
      } = req.query;

      // Build query from remaining filters
      const query = {};
      for (const [key, value] of Object.entries(filters)) {
        if (key.startsWith("_")) continue; // skip internal params

        // Support operators: field_gt, field_gte, field_lt, field_lte, field_ne
        const operatorMatch = key.match(/^(.+)_(gt|gte|lt|lte|ne)$/);
        if (operatorMatch) {
          const [, field, operator] = operatorMatch;
          if (!isFilterable(field)) continue; // skip non-filterable fields
          if (!query[field]) query[field] = {};
          query[field][`$${operator}`] = isNaN(value) ? value : Number(value);
        } else {
          if (!isFilterable(key)) continue; // skip non-filterable fields
          // Support regex search with /pattern/ or simple equality
          if (
            typeof value === "string" &&
            value.startsWith("/") &&
            value.endsWith("/")
          ) {
            query[key] = { $regex: value.slice(1, -1), $options: "i" };
          } else {
            query[key] = isNaN(value) ? value : Number(value);
          }
        }
      }

      // If search param is provided & searchBy fields are configured,
      // add $or text search across those fields
      if (search && search.trim() && searchBy.length > 0) {
        query.$or = searchBy.map((field) => ({
          [field]: { $regex: search.trim(), $options: "i" },
        }));
      }

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const skip = (pageNum - 1) * limitNum;

      // Build field selection
      const selectFields = fields ? fields.split(",").join(" ") : "";

      const [data, total] = await Promise.all([
        Model.find(query)
          .select(selectFields)
          .sort(sort)
          .skip(skip)
          .limit(limitNum)
          .lean(),
        Model.countDocuments(query),
      ]);

      res.json({
        success: true,
        data,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
          hasNext: pageNum < Math.ceil(total / limitNum),
          hasPrev: pageNum > 1,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /:id — Get one by ID ────────────────────────────────────
  router.get("/:id", async (req, res, next) => {
    try {
      const doc = await Model.findById(req.params.id).lean();
      if (!doc) {
        return res.status(404).json({
          success: false,
          error: `${resourceName} with id "${req.params.id}" not found`,
        });
      }
      res.json({ success: true, data: doc });
    } catch (err) {
      // Handle invalid ObjectId
      if (err.kind === "ObjectId") {
        return res.status(400).json({
          success: false,
          error: `Invalid ID format: "${req.params.id}"`,
        });
      }
      next(err);
    }
  });

  // ── POST / — Create new document ────────────────────────────────
  router.post("/", async (req, res, next) => {
    try {
      if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({
          success: false,
          error: "Request body cannot be empty",
        });
      }

      const doc = await Model.create(req.body);
      res.status(201).json({ success: true, data: doc });
    } catch (err) {
      // Mongoose validation error
      if (err.name === "ValidationError") {
        const errors = Object.values(err.errors).map((e) => ({
          field: e.path,
          message: e.message,
        }));
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: errors,
        });
      }
      // Duplicate key error
      if (err.code === 11000) {
        const field = Object.keys(err.keyPattern)[0];
        return res.status(409).json({
          success: false,
          error: `Duplicate value for field "${field}"`,
        });
      }
      next(err);
    }
  });

  // ── PUT /:id — Full update (replace) ────────────────────────────
  router.put("/:id", async (req, res, next) => {
    try {
      if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({
          success: false,
          error: "Request body cannot be empty",
        });
      }

      const doc = await Model.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
        overwrite: true,
      }).lean();

      if (!doc) {
        return res.status(404).json({
          success: false,
          error: `${resourceName} with id "${req.params.id}" not found`,
        });
      }
      res.json({ success: true, data: doc });
    } catch (err) {
      if (err.name === "ValidationError") {
        const errors = Object.values(err.errors).map((e) => ({
          field: e.path,
          message: e.message,
        }));
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: errors,
        });
      }
      if (err.kind === "ObjectId") {
        return res.status(400).json({
          success: false,
          error: `Invalid ID format: "${req.params.id}"`,
        });
      }
      next(err);
    }
  });

  // ── PATCH /:id — Partial update ─────────────────────────────────
  router.patch("/:id", async (req, res, next) => {
    try {
      if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({
          success: false,
          error: "Request body cannot be empty",
        });
      }

      const doc = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: req.body },
        { new: true, runValidators: true },
      ).lean();

      if (!doc) {
        return res.status(404).json({
          success: false,
          error: `${resourceName} with id "${req.params.id}" not found`,
        });
      }
      res.json({ success: true, data: doc });
    } catch (err) {
      if (err.name === "ValidationError") {
        const errors = Object.values(err.errors).map((e) => ({
          field: e.path,
          message: e.message,
        }));
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: errors,
        });
      }
      if (err.kind === "ObjectId") {
        return res.status(400).json({
          success: false,
          error: `Invalid ID format: "${req.params.id}"`,
        });
      }
      next(err);
    }
  });

  // ── DELETE /:id — Delete by ID ──────────────────────────────────
  router.delete("/:id", async (req, res, next) => {
    try {
      const doc = await Model.findByIdAndDelete(req.params.id).lean();
      if (!doc) {
        return res.status(404).json({
          success: false,
          error: `${resourceName} with id "${req.params.id}" not found`,
        });
      }
      res.json({
        success: true,
        message: `${resourceName} deleted successfully`,
        data: doc,
      });
    } catch (err) {
      if (err.kind === "ObjectId") {
        return res.status(400).json({
          success: false,
          error: `Invalid ID format: "${req.params.id}"`,
        });
      }
      next(err);
    }
  });

  return router;
}

module.exports = { createRouter };
