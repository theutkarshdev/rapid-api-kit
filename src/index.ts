import type { Express } from "express";
import type { Mongoose } from "mongoose";
import type { Server } from "http";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import { createRouter } from "./createRouter.js";
import { generateSwaggerDoc } from "./swaggerGenerator.js";
import { errorHandler, notFoundHandler } from "./middleware.js";
import {
  extractFileFields,
  convertFileFieldsForMongoose,
} from "./fileUpload.js";
import type { FileFieldConfig } from "./fileUpload.js";

// ── Types ──────────────────────────────────────────────────────────

interface ResourceDefinition {
  name: string;
  schema: Record<string, unknown>;
  searchBy?: string[];
  filterBy?: string[];
}

interface SwaggerInfo {
  title?: string;
  description?: string;
  version?: string;
}

interface RapidAPIConfig {
  port?: number;
  mongoURI: string;
  resources: ResourceDefinition[];
  cors?: Record<string, unknown>;
  logging?: boolean;
  apiPrefix?: string;
  swaggerInfo?: SwaggerInfo;
  blobToken?: string;
}

interface RapidAPIResult {
  app: Express;
  server: Server;
  mongoose: Mongoose;
}

/**
 * rapidAPI - Zero-config REST API generator
 *
 * @param config - Configuration object
 * @returns Promise resolving to Express app, HTTP server, and Mongoose instance
 */
async function rapidAPI(config: RapidAPIConfig): Promise<RapidAPIResult> {
  // ── Validate config ──────────────────────────────────────────────
  if (!config.mongoURI) {
    throw new Error(
      "❌ [rapid-api-kit] mongoURI is required. Pass your MongoDB connection string.",
    );
  }
  if (
    !config.resources ||
    !Array.isArray(config.resources) ||
    config.resources.length === 0
  ) {
    throw new Error(
      "❌ [rapid-api-kit] At least one resource is required. Example:\n" +
        '  resources: [{ name: "users", schema: { name: { type: "String", required: true } } }]',
    );
  }

  const {
    port = 5000,
    mongoURI,
    resources,
    cors: corsOptions = {},
    logging = true,
    apiPrefix = "/api",
    swaggerInfo = {},
    blobToken,
  } = config;

  // ── Validate blobToken if any resource uses File fields ────────
  const hasFileFields = resources.some((r) => {
    const fields = extractFileFields(r.schema);
    return fields.length > 0;
  });
  if (hasFileFields && !blobToken) {
    throw new Error(
      "❌ [rapid-api-kit] blobToken is required when using File fields. " +
        "Get a read-write token from Vercel Blob Storage.",
    );
  }

  // ── Create Express app ───────────────────────────────────────────
  const app = express();

  // Middleware
  app.use(cors(corsOptions));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  if (logging) {
    app.use(morgan("dev"));
  }

  // ── Connect to MongoDB ───────────────────────────────────────────
  try {
    await mongoose.connect(mongoURI);
    console.log("✅ [rapid-api-kit] Connected to MongoDB successfully!");
  } catch (err) {
    throw new Error(
      `❌ [rapid-api-kit] MongoDB connection failed: ${(err as Error).message}`,
    );
  }

  // ── Register resources ───────────────────────────────────────────
  const registeredResources: Array<{
    name: string;
    schema: Record<string, unknown>;
    path: string;
    searchBy: string[];
    filterBy: string[];
    fileFields: FileFieldConfig[];
  }> = [];

  for (const resource of resources) {
    if (!resource.name) {
      throw new Error("❌ [rapid-api-kit] Each resource must have a 'name'.");
    }
    if (!resource.schema || typeof resource.schema !== "object") {
      throw new Error(
        `❌ [rapid-api-kit] Resource "${resource.name}" must have a 'schema' object.`,
      );
    }

    const resourceName = resource.name.toLowerCase();

    // Detect and convert File fields
    const fileFields = extractFileFields(resource.schema);
    const finalSchema =
      fileFields.length > 0
        ? convertFileFieldsForMongoose(resource.schema, fileFields)
        : resource.schema;

    const mongooseSchema = new mongoose.Schema(
      finalSchema as Record<string, mongoose.SchemaDefinitionProperty>,
      {
        timestamps: true,
        versionKey: false,
      },
    );

    // Avoid model recompilation in hot-reload scenarios
    const Model =
      mongoose.models[resourceName] ||
      mongoose.model(resourceName, mongooseSchema);

    const searchBy = Array.isArray(resource.searchBy) ? resource.searchBy : [];
    const filterBy = Array.isArray(resource.filterBy) ? resource.filterBy : [];

    const router = createRouter(Model, resourceName, {
      searchBy,
      filterBy,
      fileFields,
      blobToken,
    });
    const routePath = `${apiPrefix}/${resourceName}`;
    app.use(routePath, router);

    registeredResources.push({
      name: resourceName,
      schema: resource.schema,
      path: routePath,
      searchBy,
      filterBy,
      fileFields,
    });

    console.log(`📦 [rapid-api-kit] Resource "${resourceName}" registered:`);
    console.log(`   GET    ${routePath}`);
    if (filterBy.length > 0) {
      console.log(`   GET    ${routePath}/filters/:field`);
    }
    if (searchBy.length > 0) {
      console.log(
        `          ↳ search:   ?search=keyword  (fields: ${searchBy.join(", ")})`,
      );
    }
    if (filterBy.length > 0) {
      console.log(
        `          ↳ filter:   ?${filterBy[0]}=value  (fields: ${filterBy.join(", ")})`,
      );
    }
    console.log(`   GET    ${routePath}/:id`);
    console.log(`   POST   ${routePath}`);
    console.log(`   PUT    ${routePath}/:id`);
    console.log(`   PATCH  ${routePath}/:id`);
    console.log(`   DELETE ${routePath}/:id`);
    if (fileFields.length > 0) {
      console.log(
        `          ↳ files:    ${fileFields.map((f) => f.fieldName).join(", ")} (uploaded to Vercel Blob)`,
      );
    }
  }

  // ── Swagger Docs ─────────────────────────────────────────────────
  const swaggerDoc = generateSwaggerDoc(registeredResources, {
    port,
    apiPrefix,
    ...swaggerInfo,
  });

  app.use(
    `${apiPrefix}/docs`,
    swaggerUi.serve,
    swaggerUi.setup(swaggerDoc, {
      customCss: ".swagger-ui .topbar { display: none }",
      customSiteTitle: "rapid-api-kit | API Docs",
    }),
  );

  // Serve raw swagger JSON
  app.get(`${apiPrefix}/docs.json`, (_req, res) => {
    res.json(swaggerDoc);
  });

  console.log(`📚 [rapid-api-kit] Swagger Docs available at ${apiPrefix}/docs`);

  // ── Home route ───────────────────────────────────────────────────
  app.get("/", (_req, res) => {
    res.json({
      message: "🚀 rapid-api-kit is running!",
      docs: `${apiPrefix}/docs`,
      endpoints: registeredResources.map((r) => ({
        resource: r.name,
        base: r.path,
        routes: [
          `GET    ${r.path}`,
          `GET    ${r.path}/:id`,
          `POST   ${r.path}`,
          `PUT    ${r.path}/:id`,
          `PATCH  ${r.path}/:id`,
          `DELETE ${r.path}/:id`,
        ],
      })),
    });
  });

  // ── Error handling ───────────────────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  // ── Start server ─────────────────────────────────────────────────
  const server = app.listen(port, () => {
    console.log(
      `\n🚀 [rapid-api-kit] Server running at http://localhost:${port}`,
    );
    console.log(
      `📚 [rapid-api-kit] API Docs at http://localhost:${port}${apiPrefix}/docs\n`,
    );
  });

  return { app, server, mongoose };
}

export { rapidAPI };
export type { RapidAPIConfig, RapidAPIResult, ResourceDefinition, SwaggerInfo };
