# keyv-hana

SAP HANA storage adapter for [Keyv](https://keyv.org).

[![npm](https://img.shields.io/npm/v/keyv-hana.svg)](https://www.npmjs.com/package/keyv-hana)
[![license](https://img.shields.io/npm/l/keyv-hana.svg)](https://github.com/mikezaschka/keyv-hana/blob/main/LICENSE)

## Features

- Full [`KeyvStoreAdapter`](https://keyv.org/docs/third-party-storage-adapters/) implementation
- All required methods: `get`, `set`, `delete`, `clear`
- All optional methods: `getMany`, `setMany`, `deleteMany`, `has`, `hasMany`, `iterator`, `disconnect`
- UPSERT-based writes (insert-or-update in a single statement)
- Keyset pagination for the async iterator
- Namespace support for multi-tenant usage
- HDI-compatible (`createTable: false` option)
- Works with the official `@keyv/test-suite`

## Install

```bash
npm install keyv-hana @sap/hana-client
```

`@sap/hana-client` is a **peer dependency** and must be installed alongside `keyv-hana`. It requires platform-specific native binaries (Linux, Windows, macOS) and Node.js >= 18.

## Quick Start

```typescript
import Keyv from 'keyv';
import KeyvHana from 'keyv-hana';

const store = new KeyvHana({
  host: 'localhost',
  port: 30015,
  uid: 'SYSTEM',
  pwd: 'YourPassword',
});

const keyv = new Keyv({ store });

await keyv.set('greeting', 'hello');
console.log(await keyv.get('greeting')); // 'hello'

await keyv.disconnect();
```

## Connection Options

| Option            | Type                     | Default     | Description                                                    |
| ----------------- | ------------------------ | ----------- | -------------------------------------------------------------- |
| `host`            | `string`                 | —           | SAP HANA server hostname                                       |
| `port`            | `number`                 | —           | SAP HANA server port                                           |
| `uid`             | `string`                 | —           | Database user                                                  |
| `pwd`             | `string`                 | —           | Database password                                              |
| `schema`          | `string`                 | *(current)* | HANA schema for the storage table                              |
| `table`           | `string`                 | `"KEYV"`    | Table name                                                     |
| `keySize`         | `number`                 | `255`       | Max key column length (NVARCHAR size)                          |
| `iterationLimit`  | `number`                 | `10`        | Rows fetched per iterator batch                                |
| `connectOptions`  | `ConnectionOptions`      | `{}`        | Additional `@sap/hana-client` connect options                  |
| `createTable`     | `boolean`                | `true`      | Auto-create the backing table on init. Set to `false` for HDI. |

Any extra properties accepted by `@sap/hana-client` (e.g. `encrypt`, `sslValidateCertificate`) can be passed via `connectOptions`.

## Schema & Table

The adapter stores data in a HANA **column table** with two columns:

| Column    | Type              | Description               |
| --------- | ----------------- | ------------------------- |
| `ID`      | `NVARCHAR(n)`     | Primary key (unique)      |
| `VALUE`   | `NCLOB`           | Serialized value (JSON)   |

The table is created automatically on first use. If it already exists (error code 288), the adapter silently continues.

To use a specific schema:

```typescript
const store = new KeyvHana({
  host: 'localhost',
  port: 30015,
  uid: 'SYSTEM',
  pwd: 'YourPassword',
  schema: 'MY_SCHEMA',
  table: 'MY_CACHE',
});
```

## HDI Deployment

In SAP HANA HDI (HANA Deployment Infrastructure) environments, the application connects with the **runtime user** (`_RT`), which only has DML privileges (SELECT, INSERT, UPDATE, DELETE). The **design-time user** (`_DT`) handles all DDL operations during deployment.

Because the adapter's `CREATE TABLE` statement is a DDL operation, it will fail with the runtime user. Set `createTable: false` and deploy the table as an `.hdbtable` artifact instead:

**1. Create the design-time artifact** (e.g. `db/src/KEYV.hdbtable`):

```sql
COLUMN TABLE "KEYV" (
  "ID" NVARCHAR(255) PRIMARY KEY,
  "VALUE" NCLOB
)
```

**2. Configure the adapter to skip table creation:**

```typescript
import Keyv from 'keyv';
import KeyvHana from 'keyv-hana';

const store = new KeyvHana({
  host: process.env.HANA_HOST,
  port: Number(process.env.HANA_PORT),
  uid: process.env.HANA_UID,   // runtime (_RT) user
  pwd: process.env.HANA_PWD,
  schema: process.env.HANA_SCHEMA,
  createTable: false,           // table is managed by HDI
});

const keyv = new Keyv({ store });
```

## Namespaces

Keyv supports namespaces to isolate different groups of keys. The `clear()` method only removes keys belonging to the active namespace:

```typescript
const users = new Keyv({ store: new KeyvHana(opts), namespace: 'users' });
const cache = new Keyv({ store: new KeyvHana(opts), namespace: 'cache' });

await users.set('u1', { name: 'Alice' });
await cache.set('page', '<html>…</html>');

await cache.clear(); // only removes keys prefixed with "cache:"
console.log(await users.get('u1')); // still available
```

## Testing

The test suite uses [vitest](https://vitest.dev/) and the official [`@keyv/test-suite`](https://www.npmjs.com/package/@keyv/test-suite).

Set the following environment variables to point at your HANA instance (or create a `.env` file):

```bash
export HANA_HOST=localhost
export HANA_PORT=30015
export HANA_UID=SYSTEM
export HANA_PWD=YourPassword
export HANA_SCHEMA=        # optional
export HANA_TABLE=KEYV     # optional
```

Then run:

```bash
npm test
```

## License

[MIT](LICENSE)
