# rapid-api-kit 🚀

**Zero-config REST API generator.** Give your MongoDB creds + schema, get full CRUD endpoints with Swagger docs instantly.

Built for **frontend students** who need quick backend APIs to practice with — no backend knowledge needed!

---

## What You Get

For each resource you define, you automatically get:

| Method   | Endpoint              | Description                            |
| -------- | --------------------- | -------------------------------------- |
| `GET`    | `/api/{resource}`     | List all (paginated, filtered, sorted) |
| `GET`    | `/api/{resource}/:id` | Get one by ID                          |
| `POST`   | `/api/{resource}`     | Create new                             |
| `PUT`    | `/api/{resource}/:id` | Full update (replace)                  |
| `PATCH`  | `/api/{resource}/:id` | Partial update                         |
| `DELETE` | `/api/{resource}/:id` | Delete by ID                           |

Plus:

- **Swagger UI** at `/api/docs` — interactive API playground
- **Pagination** — `?page=1&limit=10`
- **Sorting** — `?sort=-createdAt` or `?sort=name`
- **Filtering** — `?name=John&age_gte=18`
- **Search** — `?search=keyword` across configured fields
- **Field selection** — `?fields=name,email`
- **Validation** — Mongoose schema validation with clear error messages
- **CORS** enabled by default
- **Timestamps** — `createdAt` and `updatedAt` added automatically

---

## Installation

```bash
npm install @theutkarshdev/rapid-api-kit
```

---

## Quick Start

Create a file (e.g., `server.js`):

```javascript
const { rapidAPI } = require("@theutkarshdev/rapid-api-kit");

rapidAPI({
  mongoURI: "mongodb://localhost:27017/mydb",
  port: 3000,
  resources: [
    {
      name: "users",
      schema: {
        name: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        age: { type: Number },
        role: { type: String, enum: ["admin", "user"], default: "user" },
      },
      searchBy: ["name", "email"], // Enable text search on these fields
      filterBy: ["role", "age"], // Only these fields appear as filters in Swagger
    },
    {
      name: "posts",
      schema: {
        title: { type: String, required: true },
        body: { type: String },
        author: { type: String },
        published: { type: Boolean, default: false },
      },
      searchBy: ["title", "body", "author"], // Full-text search fields
      filterBy: ["author", "published"], // Filterable in Swagger UI
    },
  ],
});
```

Run it:

```bash
node server.js
```

That's it! Open `http://localhost:3000/api/docs` to see your Swagger UI.

---

## Configuration

| Option        | Type    | Default    | Description                                                                                                                       |
| ------------- | ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `mongoURI`    | string  | _required_ | MongoDB connection string                                                                                                         |
| `port`        | number  | `3000`     | Server port                                                                                                                       |
| `resources`   | array   | _required_ | Array of resource definitions                                                                                                     |
| `apiPrefix`   | string  | `"/api"`   | Base path for all endpoints                                                                                                       |
| `logging`     | boolean | `true`     | Enable Morgan request logging                                                                                                     |
| `cors`        | object  | `{}`       | CORS options (passed to cors package)                                                                                             |
| `swaggerInfo` | object  | `{}`       | Custom Swagger title, description, version                                                                                        |
| `searchBy`    | array   | `[]`       | Fields for `?search=` text search (case-insensitive)                                                                              |
| `filterBy`    | array   | `[]`       | Fields shown as query filters in Swagger UI. Enum/boolean → dropdown, others → text input. If omitted, all fields are filterable. |

### Resource Definition

```javascript
{
  name: "products",       // Collection name (lowercase, plural recommended)
  schema: {               // Mongoose schema definition
    name:     { type: String, required: true },
    price:    { type: Number, min: 0 },
    category: { type: String, enum: ["electronics", "books", "clothing"] },
    inStock:  { type: Boolean, default: true },
    tags:     [String],
  },
  searchBy: ["name"],                 // Fields for ?search=keyword (case-insensitive)
  filterBy: ["category", "inStock"],  // Fields shown as query filters in Swagger UI
}
```

### Supported Schema Types

| Type      | Example                                   |
| --------- | ----------------------------------------- |
| `String`  | `{ type: String, required: true }`        |
| `Number`  | `{ type: Number, min: 0, max: 100 }`      |
| `Boolean` | `{ type: Boolean, default: false }`       |
| `Date`    | `{ type: Date }`                          |
| `Array`   | `[String]` or `{ type: [String] }`        |
| `Enum`    | `{ type: String, enum: ["a", "b", "c"] }` |

---

## Query Examples

### Pagination

```
GET /api/users?page=2&limit=5
```

### Sorting

```
GET /api/users?sort=name          # ascending
GET /api/users?sort=-createdAt    # descending (newest first)
```

### Search

```
GET /api/users?search=john        # searches across searchBy fields (case-insensitive)
```

### Filtering

```
GET /api/users?role=admin
GET /api/users?age_gte=18&age_lte=30
GET /api/users?name=/john/         # regex search (case-insensitive)
```

**Filter operators:**

- `field_gt` — greater than
- `field_gte` — greater than or equal
- `field_lt` — less than
- `field_lte` — less than or equal
- `field_ne` — not equal

### Field Selection

```
GET /api/users?fields=name,email
```

---

## API Response Format

### Success (list)

```json
{
  "success": true,
  "data": [...],
  "pagination": {
    "total": 50,
    "page": 1,
    "limit": 10,
    "totalPages": 5,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### Success (single)

```json
{
  "success": true,
  "data": { "_id": "...", "name": "John", ... }
}
```

### Error

```json
{
  "success": false,
  "error": "Validation failed",
  "details": [{ "field": "email", "message": "Path `email` is required." }]
}
```

---

## Using with Frontend Frameworks

### React (fetch)

```javascript
// List all users
const res = await fetch("http://localhost:3000/api/users");
const { data } = await res.json();

// Create user
await fetch("http://localhost:3000/api/users", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "John", email: "john@test.com" }),
});
```

### Angular (HttpClient)

```typescript
this.http.get("http://localhost:3000/api/users").subscribe((res) => {
  this.users = res.data;
});
```

### Next.js (API route / Server Component)

```javascript
const res = await fetch("http://localhost:3000/api/users", {
  cache: "no-store",
});
const { data } = await res.json();
```

---

## Use with MongoDB Atlas (Free Cloud DB)

1. Go to [MongoDB Atlas](https://www.mongodb.com/atlas) and create a free cluster
2. Get your connection string
3. Use it:

```javascript
rapidAPI({
  mongoURI: "mongodb+srv://username:password@cluster.mongodb.net/mydb",
  resources: [...]
});
```

---

## License

MIT
