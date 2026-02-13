import EventEmitter from 'node:events';
import type { KeyvStoreAdapter, StoredData } from 'keyv';
import {
	createConnection,
	type Connection,
	type ConnectionOptions,
} from '@sap/hana-client';

/**
 * Options for the KeyvHana storage adapter.
 */
export interface KeyvHanaOptions {
	/** Dialect for the connection (default: "postgres") */
	dialect?: string;
	/** SAP HANA host */
	host?: string;
	/** SAP HANA port */
	port?: number;
	/** SAP HANA user */
	uid?: string;
	/** SAP HANA password */
	pwd?: string;
	/** SAP HANA schema (defaults to the connection's current schema) */
	schema?: string;
	/** Table name for key-value storage (default: "KEYV") */
	table?: string;
	/** Maximum key column size in characters (default: 255) */
	keySize?: number;
	/** Number of rows fetched per iterator batch (default: 10) */
	iterationLimit?: number;
	/** Additional @sap/hana-client connection options */
	connectOptions?: ConnectionOptions;
	/** Whether to auto-create the backing table on init (default: true).
	 *  Set to false in HDI environments where the table is deployed as an .hdbtable artifact. */
	createTable?: boolean;
	/** URL for the connection (default: '') */
	url?: string;
}

/**
 * SAP HANA storage adapter for Keyv.
 *
 * Implements the {@link KeyvStoreAdapter} interface backed by a SAP HANA
 * column table with `ID NVARCHAR(n) PRIMARY KEY, VALUE NCLOB`.
 *
 * @example
 * ```ts
 * import Keyv from 'keyv';
 * import KeyvHana from 'keyv-hana';
 *
 * const store = new KeyvHana({ host: 'localhost', port: 30015, uid: 'SYSTEM', pwd: 'secret' });
 * const keyv = new Keyv({ store });
 * await keyv.set('greeting', 'hello');
 * console.log(await keyv.get('greeting')); // 'hello'
 * ```
 */
export class KeyvHana extends EventEmitter implements KeyvStoreAdapter {
	ttlSupport = false;
	opts: KeyvHanaOptions;
	namespace?: string;

	private _conn: Connection | undefined;
	private _ready: Promise<void>;
	private _tableName: string;

	constructor(options: KeyvHanaOptions = {}) {
		super();

		this.opts = {
			table: 'KEYV',
			keySize: 255,
			iterationLimit: 10,
			dialect: 'postgres',
			url: '',
			...options,
		};

		this._tableName = this.opts.schema
			? `"${this.opts.schema}"."${this.opts.table}"`
			: `"${this.opts.table}"`;

		this._ready = this._init().catch((error: unknown) => {
			this.emit('error', error);
		});
	}

	// ── Lifecycle helpers ──────────────────────────────────────────────

	/**
	 * Initialise connection and ensure the backing table exists.
	 */
	private async _init(): Promise<void> {
		this._conn = createConnection();

		const connectOpts: ConnectionOptions = {
			...this.opts.connectOptions,
		};

		if (this.opts.host !== undefined) {
			connectOpts.host = this.opts.host;
		}

		if (this.opts.port !== undefined) {
			connectOpts.port = String(this.opts.port);
		}

		if (this.opts.uid !== undefined) {
			connectOpts.uid = this.opts.uid;
		}

		if (this.opts.pwd !== undefined) {
			connectOpts.pwd = this.opts.pwd;
		}

		// Connect (callback → promise)
		await new Promise<void>((resolve, reject) => {
			this._conn!.connect(connectOpts, (err: Error) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});

		// Create table if it does not exist (skipped when createTable is false,
		// e.g. in HDI environments where the table is an .hdbtable artifact)
		if (this.opts.createTable !== false) {
			const createSql = `CREATE COLUMN TABLE ${this._tableName} ("ID" NVARCHAR(${this.opts.keySize}) PRIMARY KEY, "VALUE" NCLOB)`;
			try {
				await this._rawExec(createSql);
			} catch (error: any) {
				// 288 = "cannot use duplicate table name" – table already exists
				if (error?.code !== 288) {
					throw error;
				}
			}
		}
	}

	// ── Low-level SQL execution ────────────────────────────────────────

	/**
	 * Execute a SQL statement directly on the connection.
	 * Does **not** wait for {@link _ready} – only used during init.
	 */
	private _rawExec<T>(sql: string, params?: any[]): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (!this._conn) {
				reject(new Error('Connection not established'));
				return;
			}

			const cb = (err: Error, result?: T) => {
				if (err) {
					reject(err);
				} else {
					resolve(result as T);
				}
			};

			if (params !== undefined && params.length > 0) {
				this._conn.exec<T>(sql, params, cb);
			} else {
				this._conn.exec<T>(sql, cb);
			}
		});
	}

	/**
	 * Execute a SQL statement, waiting for initialisation to complete first.
	 */
	private async _exec<T>(sql: string, params?: any[]): Promise<T> {
		await this._ready;
		return this._rawExec<T>(sql, params);
	}

	// ── Required KeyvStoreAdapter methods ──────────────────────────────

	async get<Value>(key: string): Promise<StoredData<Value> | undefined> {
		const sql = `SELECT "VALUE" FROM ${this._tableName} WHERE "ID" = ?`;
		const rows = await this._exec<Array<{ VALUE: string }>>(sql, [key]);

		if (!rows || rows.length === 0) {
			return undefined;
		}

		return rows[0].VALUE as StoredData<Value>;
	}

	async set(key: string, value: any): Promise<void> {
		const sql = `UPSERT ${this._tableName} ("ID", "VALUE") VALUES (?, ?) WHERE "ID" = ?`;
		await this._exec(sql, [key, value, key]);
	}

	async delete(key: string): Promise<boolean> {
		const existsSql = `SELECT COUNT(*) AS "CNT" FROM ${this._tableName} WHERE "ID" = ?`;
		const rows = await this._exec<Array<{ CNT: number }>>(existsSql, [key]);

		if (!rows || rows.length === 0 || rows[0].CNT === 0) {
			return false;
		}

		const deleteSql = `DELETE FROM ${this._tableName} WHERE "ID" = ?`;
		await this._exec(deleteSql, [key]);
		return true;
	}

	async clear(): Promise<void> {
		const pattern = this.namespace
			? `${this.namespace.replace(/[%_\\]/g, '\\$&')}:%`
			: '%';
		const sql = `DELETE FROM ${this._tableName} WHERE "ID" LIKE ? ESCAPE '\\'`;
		await this._exec(sql, [pattern]);
	}

	// ── Optional KeyvStoreAdapter methods ──────────────────────────────

	async getMany<Value>(
		keys: string[],
	): Promise<Array<StoredData<Value | undefined>>> {
		if (keys.length === 0) {
			return [];
		}

		const placeholders = keys.map(() => '?').join(', ');
		const sql = `SELECT "ID", "VALUE" FROM ${this._tableName} WHERE "ID" IN (${placeholders})`;
		const rows = await this._exec<Array<{ ID: string; VALUE: string }>>(
			sql,
			keys,
		);
		const rowsMap = new Map(rows.map((row) => [row.ID, row.VALUE]));
		return keys.map(
			(key) =>
				(rowsMap.get(key) as StoredData<Value | undefined>) ?? undefined,
		);
	}

	async setMany(
		entries: Array<{ key: string; value: any; ttl?: number }>,
	): Promise<void> {
		const sql = `UPSERT ${this._tableName} ("ID", "VALUE") VALUES (?, ?) WHERE "ID" = ?`;
		for (const entry of entries) {
			await this._exec(sql, [entry.key, entry.value, entry.key]);
		}
	}

	async deleteMany(keys: string[]): Promise<boolean> {
		if (keys.length === 0) {
			return false;
		}

		const placeholders = keys.map(() => '?').join(', ');
		const existsSql = `SELECT COUNT(*) AS "CNT" FROM ${this._tableName} WHERE "ID" IN (${placeholders})`;
		const rows = await this._exec<Array<{ CNT: number }>>(existsSql, keys);

		if (!rows || rows.length === 0 || rows[0].CNT === 0) {
			return false;
		}

		const deleteSql = `DELETE FROM ${this._tableName} WHERE "ID" IN (${placeholders})`;
		await this._exec(deleteSql, keys);
		return true;
	}

	async has(key: string): Promise<boolean> {
		const sql = `SELECT COUNT(*) AS "CNT" FROM ${this._tableName} WHERE "ID" = ?`;
		const rows = await this._exec<Array<{ CNT: number }>>(sql, [key]);
		return rows !== undefined && rows.length > 0 && rows[0].CNT > 0;
	}

	async hasMany(keys: string[]): Promise<boolean[]> {
		if (keys.length === 0) {
			return [];
		}

		const placeholders = keys.map(() => '?').join(', ');
		const sql = `SELECT "ID" FROM ${this._tableName} WHERE "ID" IN (${placeholders})`;
		const rows = await this._exec<Array<{ ID: string }>>(sql, keys);
		const existingKeys = new Set(rows.map((row) => row.ID));
		return keys.map((key) => existingKeys.has(key));
	}

	async *iterator<Value>(
		namespace?: string,
	): AsyncGenerator<Array<string | Awaited<Value> | undefined>, void> {
		const limit =
			Number.parseInt(String(this.opts.iterationLimit), 10) || 10;
		const escapedNamespace = namespace
			? `${namespace.replace(/[%_\\]/g, '\\$&')}:`
			: '';
		const pattern = `${escapedNamespace}%`;

		let lastKey: string | null = null;

		while (true) {
			let sql: string;
			let params: any[];

			if (lastKey === null) {
				sql = `SELECT "ID", "VALUE" FROM ${this._tableName} WHERE "ID" LIKE ? ESCAPE '\\' ORDER BY "ID" LIMIT ${limit}`;
				params = [pattern];
			} else {
				sql = `SELECT "ID", "VALUE" FROM ${this._tableName} WHERE "ID" LIKE ? ESCAPE '\\' AND "ID" > ? ORDER BY "ID" LIMIT ${limit}`;
				params = [pattern, lastKey];
			}

			const entries = await this._exec<
				Array<{ ID: string; VALUE: string }>
			>(sql, params);

			if (!entries || entries.length === 0) {
				return;
			}

			for (const entry of entries) {
				yield [entry.ID, entry.VALUE] as Array<
					string | Awaited<Value> | undefined
				>;
			}

			lastKey = entries[entries.length - 1].ID;

			if (entries.length < limit) {
				return;
			}
		}
	}

	async disconnect(): Promise<void> {
		if (this._conn) {
			await new Promise<void>((resolve, reject) => {
				this._conn!.disconnect((err?: Error) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
			this._conn = undefined;
		}
	}
}

export default KeyvHana;
