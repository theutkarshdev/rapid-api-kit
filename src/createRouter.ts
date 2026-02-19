import type { Request, Response, NextFunction, Router } from "express";
import express from "express";
import mongoose from "mongoose";
import type { Model as MongooseModel } from "mongoose";
import multer from "multer";
import type { FileFieldConfig } from "./fileUpload.js";
import {
  validateFiles,
  uploadFiles,
  deleteBlobs,
  extractBlobUrls,
} from "./fileUpload.js";

interface RouterOptions {
  searchBy?: string[];
  filterBy?: string[];
  fileFields?: FileFieldConfig[];
  blobToken?: string;
}

interface MongooseError extends Error {
  kind?: string;
  code?: number;
  keyPattern?: Record<string, unknown>;
  errors?: Record<string, { path: string; message: string }>;
}

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
function createRouter(
  Model: MongooseModel<unknown>,
  resourceName: string,
  options: RouterOptions = {},
): Router {
  const router = express.Router();
  const { searchBy = [], filterBy = [], fileFields = [], blobToken } = options;

  const hasFiles = fileFields.length > 0 && !!blobToken;

  // Set up multer for multipart/form-data when file fields exist
  // Compute the global max across all file‑field maxSize values (fallback 10 MB)
  const globalMaxSize = hasFiles
    ? Math.max(10, ...fileFields.map((f) => f.maxSize ?? 10)) * 1024 * 1024
    : 0;

  const upload = hasFiles
    ? multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: globalMaxSize },
      })
    : null;

  const multerFields = hasFiles
    ? upload!.fields(
        fileFields.map((f) => ({ name: f.fieldName, maxCount: 1 })),
      )
    : null;

  // Helper: check if a field is allowed for filtering
  const isFilterable = (field: string): boolean => {
    if (filterBy.length === 0) return false; // no filtering if filterBy not specified
    return filterBy.includes(field);
  };

  // ── GET /filters/:field — Get distinct values for a filterable field ───
  if (filterBy.length > 0) {
    router.get(
      "/filters/:field",
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const { field } = req.params;

          if (!isFilterable(field)) {
            return res.status(400).json({
              success: false,
              error: `Field "${field}" is not filterable. Allowed filter fields: ${filterBy.join(", ")}`,
            });
          }

          const values = await Model.distinct(field);

          // Sort values: strings alphabetically, numbers numerically
          values.sort((a: unknown, b: unknown) => {
            if (typeof a === "string" && typeof b === "string")
              return a.localeCompare(b);
            if (typeof a === "number" && typeof b === "number") return a - b;
            return 0;
          });

          res.json({
            success: true,
            resource: resourceName,
            field,
            count: values.length,
            values,
          });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  // ── GET / — List all with pagination, filtering, sorting & search ─
  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
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
      const query: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(filters)) {
        if (key.startsWith("_")) continue; // skip internal params

        const strValue = String(value);

        // Support operators: field_gt, field_gte, field_lt, field_lte, field_ne
        const operatorMatch = key.match(/^(.+)_(gt|gte|lt|lte|ne)$/);
        if (operatorMatch) {
          const [, field, operator] = operatorMatch;
          if (!isFilterable(field)) continue; // skip non-filterable fields
          if (!query[field]) query[field] = {};
          (query[field] as Record<string, unknown>)[`$${operator}`] = isNaN(
            Number(strValue),
          )
            ? strValue
            : Number(strValue);
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
            query[key] = isNaN(Number(strValue)) ? strValue : Number(strValue);
          }
        }
      }

      // If search param is provided & searchBy fields are configured,
      // add $or text search across those fields
      if (search && String(search).trim() && searchBy.length > 0) {
        query.$or = searchBy.map((field) => ({
          [field]: { $regex: String(search).trim(), $options: "i" },
        }));
      }

      const pageNum = Math.max(1, parseInt(String(page)));
      const limitNum = Math.min(100, Math.max(1, parseInt(String(limit))));
      const skip = (pageNum - 1) * limitNum;

      // Build field selection
      const selectFields = fields ? String(fields).split(",").join(" ") : "";

      const [data, total] = await Promise.all([
        Model.find(query)
          .select(selectFields)
          .sort(String(sort))
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
  router.get(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
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
        if ((err as MongooseError).kind === "ObjectId") {
          return res.status(400).json({
            success: false,
            error: `Invalid ID format: "${req.params.id}"`,
          });
        }
        next(err);
      }
    },
  );

  // ── POST / — Create new document ────────────────────────────────
  const postHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const body = { ...req.body };
      const files = req.files as
        | Record<string, Express.Multer.File[]>
        | undefined;

      // Check that we have at least body data or files
      const hasBody = body && Object.keys(body).length > 0;
      const hasUploadedFiles = files && Object.keys(files).length > 0;
      if (!hasBody && !hasUploadedFiles) {
        return res.status(400).json({
          success: false,
          error: "Request body cannot be empty",
        });
      }

      let uploadedUrls: Record<string, string> = {};

      if (hasFiles) {
        // Validate files (required, maxSize, accept)
        const fileErrors = validateFiles(files, fileFields, true);
        if (fileErrors.length > 0) {
          return res.status(400).json({
            success: false,
            error: "File validation failed",
            details: fileErrors,
          });
        }

        // Pre-generate MongoDB _id for a clean blob path
        const docId = new mongoose.Types.ObjectId();
        body._id = docId;

        // Upload files to Vercel Blob
        uploadedUrls = await uploadFiles(
          files,
          fileFields,
          resourceName,
          docId.toString(),
          blobToken!,
        );

        // Merge blob URLs into body
        Object.assign(body, uploadedUrls);
      }

      try {
        const doc = await Model.create(body);
        res.status(201).json({ success: true, data: doc });
      } catch (err) {
        // Rollback: delete uploaded blobs if Mongo save fails
        if (Object.keys(uploadedUrls).length > 0) {
          await deleteBlobs(Object.values(uploadedUrls), blobToken!).catch(
            () => {},
          );
        }
        throw err;
      }
    } catch (err) {
      const mongoErr = err as MongooseError;
      // Mongoose validation error
      if (mongoErr.name === "ValidationError" && mongoErr.errors) {
        const errors = Object.values(mongoErr.errors).map((e) => ({
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
      if (mongoErr.code === 11000 && mongoErr.keyPattern) {
        const field = Object.keys(mongoErr.keyPattern)[0];
        return res.status(409).json({
          success: false,
          error: `Duplicate value for field "${field}"`,
        });
      }
      next(err);
    }
  };

  if (multerFields) {
    router.post("/", multerFields, postHandler);
  } else {
    router.post("/", postHandler);
  }

  // ── PUT /:id — Full update (replace) ────────────────────────────
  const putHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const body = { ...req.body };
      const files = req.files as
        | Record<string, Express.Multer.File[]>
        | undefined;

      const hasBody = body && Object.keys(body).length > 0;
      const hasUploadedFiles = files && Object.keys(files).length > 0;
      if (!hasBody && !hasUploadedFiles) {
        return res.status(400).json({
          success: false,
          error: "Request body cannot be empty",
        });
      }

      let uploadedUrls: Record<string, string> = {};
      let oldBlobUrls: string[] = [];

      if (hasFiles) {
        const fileErrors = validateFiles(files, fileFields, false);
        if (fileErrors.length > 0) {
          return res.status(400).json({
            success: false,
            error: "File validation failed",
            details: fileErrors,
          });
        }

        // Get old document to find existing blob URLs for cleanup
        const oldDoc = await Model.findById(req.params.id).lean();
        if (oldDoc) {
          oldBlobUrls = extractBlobUrls(
            oldDoc as Record<string, unknown>,
            fileFields,
          );
        }

        uploadedUrls = await uploadFiles(
          files,
          fileFields,
          resourceName,
          req.params.id,
          blobToken!,
        );
        Object.assign(body, uploadedUrls);
      }

      const doc = await Model.findByIdAndUpdate(req.params.id, body, {
        new: true,
        runValidators: true,
        overwrite: true,
      }).lean();

      if (!doc) {
        // Rollback uploads if doc not found
        if (Object.keys(uploadedUrls).length > 0) {
          await deleteBlobs(Object.values(uploadedUrls), blobToken!).catch(
            () => {},
          );
        }
        return res.status(404).json({
          success: false,
          error: `${resourceName} with id "${req.params.id}" not found`,
        });
      }

      // Clean up old blobs after successful update
      if (oldBlobUrls.length > 0) {
        await deleteBlobs(oldBlobUrls, blobToken!).catch(() => {});
      }

      res.json({ success: true, data: doc });
    } catch (err) {
      const mongoErr = err as MongooseError;
      if (mongoErr.name === "ValidationError" && mongoErr.errors) {
        const errors = Object.values(mongoErr.errors).map((e) => ({
          field: e.path,
          message: e.message,
        }));
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: errors,
        });
      }
      if (mongoErr.kind === "ObjectId") {
        return res.status(400).json({
          success: false,
          error: `Invalid ID format: "${req.params.id}"`,
        });
      }
      next(err);
    }
  };

  if (multerFields) {
    router.put("/:id", multerFields, putHandler);
  } else {
    router.put("/:id", putHandler);
  }

  // ── PATCH /:id — Partial update ─────────────────────────────────
  const patchHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const body = { ...req.body };
      const files = req.files as
        | Record<string, Express.Multer.File[]>
        | undefined;

      const hasBody = body && Object.keys(body).length > 0;
      const hasUploadedFiles = files && Object.keys(files).length > 0;
      if (!hasBody && !hasUploadedFiles) {
        return res.status(400).json({
          success: false,
          error: "Request body cannot be empty",
        });
      }

      let uploadedUrls: Record<string, string> = {};
      const oldBlobUrlsToDelete: string[] = [];

      if (hasFiles && hasUploadedFiles) {
        const fileErrors = validateFiles(files, fileFields, false);
        if (fileErrors.length > 0) {
          return res.status(400).json({
            success: false,
            error: "File validation failed",
            details: fileErrors,
          });
        }

        // Get old document to find existing blob URLs for updated fields only
        const oldDoc = await Model.findById(req.params.id).lean();
        if (oldDoc) {
          const oldDocData = oldDoc as Record<string, unknown>;
          // Only delete old blobs for fields being re-uploaded
          for (const ff of fileFields) {
            if (files?.[ff.fieldName]) {
              const oldUrl = oldDocData[ff.fieldName];
              if (typeof oldUrl === "string" && oldUrl.startsWith("http")) {
                oldBlobUrlsToDelete.push(oldUrl);
              }
            }
          }
        }

        uploadedUrls = await uploadFiles(
          files,
          fileFields,
          resourceName,
          req.params.id,
          blobToken!,
        );
        Object.assign(body, uploadedUrls);
      }

      const doc = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: body },
        { new: true, runValidators: true },
      ).lean();

      if (!doc) {
        // Rollback uploads if doc not found
        if (Object.keys(uploadedUrls).length > 0) {
          await deleteBlobs(Object.values(uploadedUrls), blobToken!).catch(
            () => {},
          );
        }
        return res.status(404).json({
          success: false,
          error: `${resourceName} with id "${req.params.id}" not found`,
        });
      }

      // Clean up old blobs after successful update
      if (oldBlobUrlsToDelete.length > 0) {
        await deleteBlobs(oldBlobUrlsToDelete, blobToken!).catch(() => {});
      }

      res.json({ success: true, data: doc });
    } catch (err) {
      const mongoErr = err as MongooseError;
      if (mongoErr.name === "ValidationError" && mongoErr.errors) {
        const errors = Object.values(mongoErr.errors).map((e) => ({
          field: e.path,
          message: e.message,
        }));
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: errors,
        });
      }
      if (mongoErr.kind === "ObjectId") {
        return res.status(400).json({
          success: false,
          error: `Invalid ID format: "${req.params.id}"`,
        });
      }
      next(err);
    }
  };

  if (multerFields) {
    router.patch("/:id", multerFields, patchHandler);
  } else {
    router.patch("/:id", patchHandler);
  }

  // ── DELETE /:id — Delete by ID ──────────────────────────────────
  router.delete(
    "/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const doc = await Model.findByIdAndDelete(req.params.id).lean();
        if (!doc) {
          return res.status(404).json({
            success: false,
            error: `${resourceName} with id "${req.params.id}" not found`,
          });
        }

        // Clean up blobs associated with deleted document
        if (hasFiles) {
          const blobUrls = extractBlobUrls(
            doc as Record<string, unknown>,
            fileFields,
          );
          if (blobUrls.length > 0) {
            await deleteBlobs(blobUrls, blobToken!).catch(() => {});
          }
        }

        res.json({
          success: true,
          message: `${resourceName} deleted successfully`,
          data: doc,
        });
      } catch (err) {
        if ((err as MongooseError).kind === "ObjectId") {
          return res.status(400).json({
            success: false,
            error: `Invalid ID format: "${req.params.id}"`,
          });
        }
        next(err);
      }
    },
  );

  return router;
}

export { createRouter };
