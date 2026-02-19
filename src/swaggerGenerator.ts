/**
 * Auto-generates a Swagger/OpenAPI 3.0 spec from registered resources
 */

// ── Types ──────────────────────────────────────────────────────────

interface SwaggerSchema {
  type: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  items?: SwaggerSchema;
  properties?: Record<string, SwaggerSchema>;
}

interface SchemaFieldDef {
  type?: unknown;
  enum?: unknown[];
  default?: unknown;
  ref?: string;
  required?: boolean;
  [key: string]: unknown;
}

interface RegisteredResource {
  name: string;
  schema: Record<string, unknown>;
  path: string;
  searchBy: string[];
  filterBy: string[];
  fileFields: Array<{
    fieldName: string;
    required?: boolean;
    maxSize?: number;
    accept?: string;
  }>;
}

interface SwaggerOptions {
  title?: string;
  description?: string;
  version?: string;
  port?: number;
  apiPrefix?: string;
}

interface SwaggerParameter {
  name: string;
  in: string;
  schema: Record<string, unknown>;
  description: string;
  required?: boolean;
}

interface SwaggerDoc {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
  };
}

// Map Mongoose types → Swagger types
const TYPE_MAP: Record<string, SwaggerSchema> = {
  String: { type: "string" },
  Number: { type: "number" },
  Boolean: { type: "boolean" },
  Date: { type: "string", format: "date-time" },
  ObjectId: { type: "string" },
  Buffer: { type: "string", format: "binary" },
  Mixed: { type: "object" },
  Array: { type: "array", items: { type: "string" } },
  Map: { type: "object" },
  Decimal128: { type: "number" },
};

function resolveSwaggerType(fieldDef: unknown): SwaggerSchema {
  // Handle File type → Swagger binary for display schemas
  if (
    typeof fieldDef === "string" &&
    (fieldDef === "File" || fieldDef === "file")
  ) {
    return { type: "string", description: "URL of uploaded file" };
  }

  // Handle shorthand: { name: String } or { name: "String" }
  // Always spread to avoid mutating the shared TYPE_MAP objects
  if (typeof fieldDef === "function") {
    return {
      ...(TYPE_MAP[(fieldDef as { name: string }).name] || { type: "string" }),
    };
  }
  if (typeof fieldDef === "string") {
    return { ...(TYPE_MAP[fieldDef] || { type: "string" }) };
  }

  // Handle array syntax: [String] or [{ type: String }]
  if (Array.isArray(fieldDef)) {
    const itemType =
      fieldDef.length > 0
        ? resolveSwaggerType(fieldDef[0])
        : { type: "string" };
    return { type: "array", items: itemType };
  }

  // Handle object with `type` key
  if (
    fieldDef &&
    typeof fieldDef === "object" &&
    (fieldDef as SchemaFieldDef).type
  ) {
    const typedField = fieldDef as SchemaFieldDef;

    // Handle File type in object form
    if (typedField.type === "File" || typedField.type === "file") {
      const desc = [
        "URL of uploaded file",
        typedField.maxSize ? `Max: ${typedField.maxSize}MB` : "",
        typedField.accept ? `Accepts: ${typedField.accept}` : "",
      ]
        .filter(Boolean)
        .join(". ");
      return { type: "string", description: desc };
    }

    const baseType = resolveSwaggerType(typedField.type);

    // Add enum if present
    if (typedField.enum) {
      baseType.enum = typedField.enum;
    }

    // Add default
    if (typedField.default !== undefined) {
      baseType.default = typedField.default;
    }

    // Add description from mongoose 'description' or 'ref'
    if (typedField.ref) {
      baseType.description = `Reference to ${typedField.ref}`;
    }

    return baseType;
  }

  // Nested object (sub-document)
  if (fieldDef && typeof fieldDef === "object") {
    const properties: Record<string, SwaggerSchema> = {};
    for (const [key, val] of Object.entries(
      fieldDef as Record<string, unknown>,
    )) {
      properties[key] = resolveSwaggerType(val);
    }
    return { type: "object", properties };
  }

  return { type: "string" };
}

function buildSchemaProperties(schema: Record<string, unknown>): {
  properties: Record<string, SwaggerSchema>;
  required: string[];
} {
  const properties: Record<string, SwaggerSchema> = {};
  const required: string[] = [];

  for (const [key, fieldDef] of Object.entries(schema)) {
    properties[key] = resolveSwaggerType(fieldDef);

    // Check if field is required
    if (
      fieldDef &&
      typeof fieldDef === "object" &&
      !Array.isArray(fieldDef) &&
      (fieldDef as SchemaFieldDef).required === true
    ) {
      required.push(key);
    }
  }

  return { properties, required };
}

/**
 * Build a clean schema for a filter query parameter.
 * - enum fields   → keep enum array so Swagger UI shows a dropdown
 * - boolean fields → add explicit enum [true, false] for a dropdown
 * - everything else → bare type only (plain text input, no suggestions)
 */
function buildFilterParamSchema(fieldSchema: SwaggerSchema): SwaggerSchema {
  const schema: SwaggerSchema = { type: fieldSchema.type };

  if (fieldSchema.enum) {
    // Enum field → dropdown
    schema.enum = fieldSchema.enum;
  } else if (fieldSchema.type === "boolean") {
    // Boolean without explicit enum → dropdown with true / false
    schema.enum = [true, false];
  }

  // Preserve format (e.g. date-time) so Swagger renders the correct input
  if (fieldSchema.format) {
    schema.format = fieldSchema.format;
  }

  // Intentionally omit `default` so filters don't get pre-filled
  return schema;
}

function generateSwaggerDoc(
  resources: RegisteredResource[],
  options: SwaggerOptions = {},
): SwaggerDoc {
  const {
    title = "rapid-api-kit",
    description = "Auto-generated REST API documentation",
    version = "1.0.0",
    port = 5000,
    apiPrefix = "/api",
  } = options;

  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const resource of resources) {
    const {
      name,
      schema,
      path: basePath,
      searchBy = [],
      filterBy = [],
      fileFields = [],
    } = resource;
    const capitalName = name.charAt(0).toUpperCase() + name.slice(1);
    const { properties, required } = buildSchemaProperties(schema);
    const hasFileFields = fileFields.length > 0;

    // Build file field names set for quick lookup
    const fileFieldNames = new Set(fileFields.map((f) => f.fieldName));

    // ── Define schemas ─────────────────────────────────────────
    schemas[capitalName] = {
      type: "object",
      properties: {
        _id: { type: "string", description: "MongoDB ObjectId" },
        ...properties,
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    };

    schemas[`${capitalName}Input`] = {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };

    // Build multipart schema for resources with file fields
    let postRequestBody: Record<string, unknown>;
    let putPatchRequestBody: Record<string, unknown>;

    if (hasFileFields) {
      // Multipart properties: non-file fields stay as-is, file fields become binary
      const multipartProps: Record<string, SwaggerSchema> = {};
      for (const [key, val] of Object.entries(properties)) {
        if (fileFieldNames.has(key)) {
          const ff = fileFields.find((f) => f.fieldName === key);
          multipartProps[key] = {
            type: "string",
            format: "binary",
            description: [
              "File upload",
              ff?.maxSize ? `Max: ${ff.maxSize}MB` : "",
              ff?.accept ? `Accepts: ${ff.accept}` : "",
            ]
              .filter(Boolean)
              .join(". "),
          };
        } else {
          multipartProps[key] = val;
        }
      }

      postRequestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: multipartProps,
              ...(required.length > 0 ? { required } : {}),
            },
          },
        },
      };
      putPatchRequestBody = {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: multipartProps,
            },
          },
        },
      };
    } else {
      postRequestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${capitalName}Input` },
          },
        },
      };
      putPatchRequestBody = {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${capitalName}Input` },
          },
        },
      };
    }

    // ── Paths ──────────────────────────────────────────────────

    const baseParams: SwaggerParameter[] = [
      {
        name: "page",
        in: "query",
        schema: { type: "integer", default: 1 },
        description: "Page number",
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", default: 10, maximum: 100 },
        description: "Items per page",
      },
      {
        name: "sort",
        in: "query",
        schema: { type: "string", default: "-createdAt" },
        description: "Sort field (prefix with - for descending)",
      },
      {
        name: "fields",
        in: "query",
        schema: { type: "string" },
        description:
          "Comma-separated field names to return in response (e.g. name,email)",
      },
    ];

    const searchParams: SwaggerParameter[] =
      searchBy.length > 0
        ? [
            {
              name: "search",
              in: "query",
              schema: { type: "string" },
              description: `Text search across fields: ${searchBy.join(", ")} (case-insensitive)`,
              required: false,
            },
          ]
        : [];

    const filterParams: SwaggerParameter[] =
      filterBy.length > 0
        ? filterBy
            .filter((field) => properties[field])
            .map((field) => {
              const paramSchema = buildFilterParamSchema(properties[field]);
              return {
                name: field,
                in: "query",
                schema: paramSchema as unknown as Record<string, unknown>,
                description: paramSchema.enum
                  ? `Filter by ${field} (${paramSchema.enum.join(", ")})`
                  : `Filter by ${field}`,
                required: false,
              };
            })
        : [];

    // GET / and POST /
    paths[basePath] = {
      get: {
        tags: [capitalName],
        summary: `List all ${name}`,
        description: `Retrieve a paginated list of ${name}. Supports filtering, sorting, field selection${searchBy.length > 0 ? " and text search (searchable fields: " + searchBy.join(", ") + ")" : ""}.${filterBy.length > 0 ? " Filterable fields: " + filterBy.join(", ") + "." : ""}`,
        parameters: [...baseParams, ...searchParams, ...filterParams],
        responses: {
          200: {
            description: `List of ${name}`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: {
                      type: "array",
                      items: { $ref: `#/components/schemas/${capitalName}` },
                    },
                    pagination: {
                      type: "object",
                      properties: {
                        total: { type: "integer" },
                        page: { type: "integer" },
                        limit: { type: "integer" },
                        totalPages: { type: "integer" },
                        hasNext: { type: "boolean" },
                        hasPrev: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: [capitalName],
        summary: `Create a new ${name.slice(0, -1) || name}`,
        description: `Create a new ${name.slice(0, -1) || name} record${hasFileFields ? " (multipart/form-data for file uploads)" : ""}`,
        requestBody: postRequestBody,
        responses: {
          201: {
            description: `${capitalName} created successfully`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { $ref: `#/components/schemas/${capitalName}` },
                  },
                },
              },
            },
          },
          400: { description: "Validation error" },
          409: { description: "Duplicate key error" },
        },
      },
    };

    // GET /filters/:field — Get distinct values for a filterable field
    if (filterBy.length > 0) {
      paths[`${basePath}/filters/{field}`] = {
        get: {
          tags: [capitalName],
          summary: `Get distinct values for a filterable field on ${name}`,
          description: `Returns all unique values for a given filterable field. Use this to populate \`<select>\` dropdowns in the frontend. Allowed fields: ${filterBy.join(", ")}.`,
          parameters: [
            {
              name: "field",
              in: "path",
              required: true,
              schema: { type: "string", enum: filterBy },
              description: `Filterable field name (${filterBy.join(", ")})`,
            },
          ],
          responses: {
            200: {
              description: "Distinct values for the field",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      resource: { type: "string" },
                      field: { type: "string" },
                      count: { type: "integer" },
                      values: {
                        type: "array",
                        items: {},
                        description: "Sorted list of unique values",
                      },
                    },
                  },
                },
              },
            },
            400: { description: "Field is not filterable" },
          },
        },
      };
    }

    // GET /:id, PUT /:id, PATCH /:id, DELETE /:id
    paths[`${basePath}/{id}`] = {
      get: {
        tags: [capitalName],
        summary: `Get a ${name.slice(0, -1) || name} by ID`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "MongoDB ObjectId",
          },
        ],
        responses: {
          200: {
            description: `${capitalName} found`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { $ref: `#/components/schemas/${capitalName}` },
                  },
                },
              },
            },
          },
          404: { description: `${capitalName} not found` },
          400: { description: "Invalid ID format" },
        },
      },
      put: {
        tags: [capitalName],
        summary: `Replace a ${name.slice(0, -1) || name}`,
        description: `Fully replace a ${name.slice(0, -1) || name} by ID${hasFileFields ? " (multipart/form-data for file uploads)" : ""}`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "MongoDB ObjectId",
          },
        ],
        requestBody: putPatchRequestBody,
        responses: {
          200: {
            description: `${capitalName} updated`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { $ref: `#/components/schemas/${capitalName}` },
                  },
                },
              },
            },
          },
          404: { description: `${capitalName} not found` },
          400: { description: "Validation error or invalid ID" },
        },
      },
      patch: {
        tags: [capitalName],
        summary: `Update a ${name.slice(0, -1) || name}`,
        description: `Partially update a ${name.slice(0, -1) || name} by ID${hasFileFields ? " (multipart/form-data for file uploads)" : ""}`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "MongoDB ObjectId",
          },
        ],
        requestBody: putPatchRequestBody,
        responses: {
          200: {
            description: `${capitalName} updated`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    data: { $ref: `#/components/schemas/${capitalName}` },
                  },
                },
              },
            },
          },
          404: { description: `${capitalName} not found` },
          400: { description: "Validation error or invalid ID" },
        },
      },
      delete: {
        tags: [capitalName],
        summary: `Delete a ${name.slice(0, -1) || name}`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "MongoDB ObjectId",
          },
        ],
        responses: {
          200: {
            description: `${capitalName} deleted`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    message: { type: "string" },
                    data: { $ref: `#/components/schemas/${capitalName}` },
                  },
                },
              },
            },
          },
          404: { description: `${capitalName} not found` },
          400: { description: "Invalid ID format" },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title,
      description,
      version,
    },
    servers: [
      {
        url: `http://localhost:${port}`,
        description: "Local development server",
      },
    ],
    paths,
    components: { schemas },
  };
}

export { generateSwaggerDoc };
export type { RegisteredResource, SwaggerOptions, SwaggerDoc };
