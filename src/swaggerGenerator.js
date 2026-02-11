/**
 * Auto-generates a Swagger/OpenAPI 3.0 spec from registered resources
 */

// Map Mongoose types → Swagger types
const TYPE_MAP = {
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

function resolveSwaggerType(fieldDef) {
  // Handle shorthand: { name: String } or { name: "String" }
  // Always spread to avoid mutating the shared TYPE_MAP objects
  if (typeof fieldDef === "function") {
    return { ...(TYPE_MAP[fieldDef.name] || { type: "string" }) };
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
  if (fieldDef && typeof fieldDef === "object" && fieldDef.type) {
    const baseType = resolveSwaggerType(fieldDef.type);

    // Add enum if present
    if (fieldDef.enum) {
      baseType.enum = fieldDef.enum;
    }

    // Add default
    if (fieldDef.default !== undefined) {
      baseType.default = fieldDef.default;
    }

    // Add description from mongoose 'description' or 'ref'
    if (fieldDef.ref) {
      baseType.description = `Reference to ${fieldDef.ref}`;
    }

    return baseType;
  }

  // Nested object (sub-document)
  if (fieldDef && typeof fieldDef === "object") {
    const properties = {};
    for (const [key, val] of Object.entries(fieldDef)) {
      properties[key] = resolveSwaggerType(val);
    }
    return { type: "object", properties };
  }

  return { type: "string" };
}

function buildSchemaProperties(schema) {
  const properties = {};
  const required = [];

  for (const [key, fieldDef] of Object.entries(schema)) {
    properties[key] = resolveSwaggerType(fieldDef);

    // Check if field is required
    if (
      fieldDef &&
      typeof fieldDef === "object" &&
      !Array.isArray(fieldDef) &&
      fieldDef.required === true
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
function buildFilterParamSchema(fieldSchema) {
  const schema = { type: fieldSchema.type };

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

function generateSwaggerDoc(resources, options = {}) {
  const {
    title = "rapid-api-kit",
    description = "Auto-generated REST API documentation",
    version = "1.0.0",
    port = 3000,
    apiPrefix = "/api",
  } = options;

  const paths = {};
  const schemas = {};

  for (const resource of resources) {
    const {
      name,
      schema,
      path: basePath,
      searchBy = [],
      filterBy = [],
    } = resource;
    const capitalName = name.charAt(0).toUpperCase() + name.slice(1);
    const { properties, required } = buildSchemaProperties(schema);

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

    // ── Paths ──────────────────────────────────────────────────

    // GET / and POST /
    paths[basePath] = {
      get: {
        tags: [capitalName],
        summary: `List all ${name}`,
        description: `Retrieve a paginated list of ${name}. Supports filtering, sorting, field selection${searchBy.length > 0 ? " and text search (searchable fields: " + searchBy.join(", ") + ")" : ""}.${filterBy.length > 0 ? " Filterable fields: " + filterBy.join(", ") + "." : ""}`,
        parameters: [
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
            description: "Comma-separated field names to return",
          },
          // Search param (only if searchBy is configured)
          ...(searchBy.length > 0
            ? [
                {
                  name: "search",
                  in: "query",
                  schema: { type: "string" },
                  description: `Text search across fields: ${searchBy.join(", ")} (case-insensitive)`,
                  required: false,
                },
              ]
            : []),
          // Only show filterable fields as query params
          // enum / boolean → dropdown, everything else → plain text input
          ...(filterBy.length > 0
            ? filterBy
                .filter((field) => properties[field])
                .map((field) => {
                  const paramSchema = buildFilterParamSchema(properties[field]);
                  return {
                    name: field,
                    in: "query",
                    schema: paramSchema,
                    description: paramSchema.enum
                      ? `Filter by ${field} (${paramSchema.enum.join(", ")})`
                      : `Filter by ${field}`,
                    required: false,
                  };
                })
            : Object.keys(properties).map((field) => {
                const paramSchema = buildFilterParamSchema(properties[field]);
                return {
                  name: field,
                  in: "query",
                  schema: paramSchema,
                  description: paramSchema.enum
                    ? `Filter by ${field} (${paramSchema.enum.join(", ")})`
                    : `Filter by ${field}`,
                  required: false,
                };
              })),
        ],
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
        description: `Create a new ${name.slice(0, -1) || name} record`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${capitalName}Input` },
            },
          },
        },
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
        description: `Fully replace a ${name.slice(0, -1) || name} by ID`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "MongoDB ObjectId",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${capitalName}Input` },
            },
          },
        },
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
        description: `Partially update a ${name.slice(0, -1) || name} by ID`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "MongoDB ObjectId",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${capitalName}Input` },
            },
          },
        },
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

module.exports = { generateSwaggerDoc };
