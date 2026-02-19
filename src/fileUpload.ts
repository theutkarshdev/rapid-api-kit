import { put, del } from "@vercel/blob";
import path from "path";

// ── Types ──────────────────────────────────────────────────────────

interface FileFieldConfig {
  fieldName: string;
  required?: boolean;
  maxSize?: number; // in MB
  accept?: string; // comma-separated MIME types or extensions (like HTML <input accept="">)
}

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Detects fields with `type: "File"` in a resource schema definition
 * and returns their configs (fieldName, required, maxSize, accept).
 */
function extractFileFields(schema: Record<string, unknown>): FileFieldConfig[] {
  const fileFields: FileFieldConfig[] = [];

  for (const [key, fieldDef] of Object.entries(schema)) {
    if (fieldDef === "File" || fieldDef === "file") {
      fileFields.push({ fieldName: key });
      continue;
    }

    if (fieldDef && typeof fieldDef === "object" && !Array.isArray(fieldDef)) {
      const def = fieldDef as Record<string, unknown>;
      if (def.type === "File" || def.type === "file") {
        fileFields.push({
          fieldName: key,
          required: def.required === true,
          maxSize: typeof def.maxSize === "number" ? def.maxSize : undefined,
          accept: typeof def.accept === "string" ? def.accept : undefined,
        });
      }
    }
  }

  return fileFields;
}

/**
 * Converts `type: "File"` fields to `type: String` so Mongoose stores the
 * blob URL as a plain string.  Returns a new schema object (does not mutate).
 */
function convertFileFieldsForMongoose(
  schema: Record<string, unknown>,
  fileFields: FileFieldConfig[],
): Record<string, unknown> {
  const converted = { ...schema };
  for (const ff of fileFields) {
    const existing = converted[ff.fieldName];

    if (typeof existing === "string") {
      // shorthand like  idCard: "File"
      converted[ff.fieldName] = { type: String };
    } else if (existing && typeof existing === "object") {
      const {
        type: _type,
        maxSize: _ms,
        accept: _ac,
        ...rest
      } = existing as Record<string, unknown>;
      converted[ff.fieldName] = { ...rest, type: String };
    }
  }
  return converted;
}

/**
 * Check if a file's MIME type / extension is allowed by the `accept` string.
 * Supports the same syntax as the HTML `<input accept="">` attribute:
 *  - Extensions:  `.pdf`, `.jpg`
 *  - Wildcards:   `image/*`, `video/*`
 *  - Exact MIME:  `image/png`, `application/pdf`
 */
function isFileAccepted(file: MulterFile, accept: string): boolean {
  const rules = accept.split(",").map((r) => r.trim().toLowerCase());
  const mime = file.mimetype.toLowerCase();
  const ext = path.extname(file.originalname).toLowerCase();

  return rules.some((rule) => {
    if (rule.startsWith(".")) return ext === rule; // .pdf
    if (rule.endsWith("/*")) return mime.startsWith(rule.replace("/*", "/")); // image/*
    return mime === rule; // image/png
  });
}

/**
 * Validates all uploaded files against their field configs.
 * Returns an array of error strings (empty = valid).
 */
function validateFiles(
  files: Record<string, MulterFile[]> | undefined,
  fileFields: FileFieldConfig[],
  isCreate: boolean,
): string[] {
  const errors: string[] = [];

  for (const ff of fileFields) {
    const uploaded = files?.[ff.fieldName]?.[0];

    // Required check (only enforce on create)
    if (ff.required && isCreate && !uploaded) {
      errors.push(`File field "${ff.fieldName}" is required`);
      continue;
    }

    if (!uploaded) continue;

    // Max size check
    if (ff.maxSize && uploaded.size > ff.maxSize * 1024 * 1024) {
      const actualMB = (uploaded.size / (1024 * 1024)).toFixed(2);
      errors.push(
        `File "${ff.fieldName}" exceeds max size of ${ff.maxSize}MB (got ${actualMB}MB)`,
      );
    }

    // Accept check
    if (ff.accept && !isFileAccepted(uploaded, ff.accept)) {
      errors.push(
        `File "${ff.fieldName}" type "${uploaded.mimetype}" not allowed. Accepted: ${ff.accept}`,
      );
    }
  }

  return errors;
}

/**
 * Uploads files to Vercel Blob Storage and returns a map of
 * fieldName → blob URL.
 *
 * Path format:  {resourceName}/{documentId}/{fieldName}-{timestamp}.{ext}
 */
async function uploadFiles(
  files: Record<string, MulterFile[]> | undefined,
  fileFields: FileFieldConfig[],
  resourceName: string,
  documentId: string,
  token: string,
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};

  for (const ff of fileFields) {
    const uploaded = files?.[ff.fieldName]?.[0];
    if (!uploaded) continue;

    const ext = path.extname(uploaded.originalname) || "";
    const blobPath = `${resourceName}/${documentId}/${ff.fieldName}-${Date.now()}${ext}`;

    const blob = await put(blobPath, uploaded.buffer, {
      access: "public",
      token,
    });

    urls[ff.fieldName] = blob.url;
  }

  return urls;
}

/**
 * Deletes one or more blob URLs from Vercel Blob Storage.
 * Silently ignores errors for individual deletions.
 */
async function deleteBlobs(urls: string[], token: string): Promise<void> {
  const deletePromises = urls.map((url) =>
    del(url, { token }).catch(() => {
      // Silently ignore — blob may already be deleted or URL may be invalid
    }),
  );
  await Promise.all(deletePromises);
}

/**
 * Extracts blob URLs from a document for the given file fields.
 */
function extractBlobUrls(
  doc: Record<string, unknown>,
  fileFields: FileFieldConfig[],
): string[] {
  const urls: string[] = [];
  for (const ff of fileFields) {
    const val = doc[ff.fieldName];
    if (typeof val === "string" && val.startsWith("http")) {
      urls.push(val);
    }
  }
  return urls;
}

export {
  extractFileFields,
  convertFileFieldsForMongoose,
  validateFiles,
  uploadFiles,
  deleteBlobs,
  extractBlobUrls,
};
export type { FileFieldConfig, MulterFile };
