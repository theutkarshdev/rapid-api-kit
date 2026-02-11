const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const { createRouter } = require("./createRouter");
const { generateSwaggerDoc } = require("./swaggerGenerator");
const { errorHandler, notFoundHandler } = require("./middleware");

/**
 * rapidAPI - Zero-config REST API generator
 *
 * @param {Object} config
 * @param {number}  [config.port=3000]         - Port to run the server on
 * @param {string}  config.mongoURI            - MongoDB connection string
 * @param {Array}   config.resources           - Array of resource definitions
 * @param {string}  config.resources[].name       - Resource/collection name (e.g. "users")
 * @param {Object}  config.resources[].schema     - Mongoose-style schema definition
 * @param {Array}   [config.resources[].searchBy] - Fields to enable text search on (GET /search?q=)
 * @param {Array}   [config.resources[].filterBy] - Fields allowed for query filtering (restricts which fields work as filters)
 * @param {Object}  [config.cors]              - CORS options (passed to cors middleware)
 * @param {boolean} [config.logging=true]      - Enable request logging
 * @param {string}  [config.apiPrefix="/api"]  - Base path prefix for all routes
 * @param {Object}  [config.swaggerInfo]       - Custom Swagger info (title, description, version)
 * @returns {Promise<{app: Express, server: http.Server, mongoose: Mongoose}>}
 */
async function rapidAPI(config = {}) {
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
    port = 3000,
    mongoURI,
    resources,
    cors: corsOptions = {},
    logging = true,
    apiPrefix = "/api",
    swaggerInfo = {},
  } = config;

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
      `❌ [rapid-api-kit] MongoDB connection failed: ${err.message}`,
    );
  }

  // ── Register resources ───────────────────────────────────────────
  const registeredResources = [];

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
    const mongooseSchema = new mongoose.Schema(resource.schema, {
      timestamps: true,
      versionKey: false,
    });

    // Avoid model recompilation in hot-reload scenarios
    const Model =
      mongoose.models[resourceName] ||
      mongoose.model(resourceName, mongooseSchema);

    const searchBy = Array.isArray(resource.searchBy) ? resource.searchBy : [];
    const filterBy = Array.isArray(resource.filterBy) ? resource.filterBy : [];

    const router = createRouter(Model, resourceName, { searchBy, filterBy });
    const routePath = `${apiPrefix}/${resourceName}`;
    app.use(routePath, router);

    registeredResources.push({
      name: resourceName,
      schema: resource.schema,
      path: routePath,
      searchBy,
      filterBy,
    });

    console.log(`📦 [rapid-api-kit] Resource "${resourceName}" registered:`);
    console.log(`   GET    ${routePath}`);
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
  app.get(`${apiPrefix}/docs.json`, (req, res) => {
    res.json(swaggerDoc);
  });

  console.log(`📚 [rapid-api-kit] Swagger Docs available at ${apiPrefix}/docs`);

  // ── Home route ───────────────────────────────────────────────────
  app.get("/", (req, res) => {
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

module.exports = { rapidAPI };
