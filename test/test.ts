import * as test from 'vitest';
import keyvTestSuite, { keyvIteratorTests } from '@keyv/test-suite';
import Keyv from 'keyv';
import KeyvHana from '../src/index.js';

// Connection options can be overridden via environment variables
const hanaOptions = {
	host: process.env.HANA_HOST ?? 'localhost',
	port: Number(process.env.HANA_PORT ?? 30015),
	uid: process.env.HANA_UID ?? 'SYSTEM',
	pwd: process.env.HANA_PWD ?? '',
	schema: process.env.HANA_SCHEMA,
	table: process.env.HANA_TABLE ?? 'KEYV',
	iterationLimit: 2,
	createTable: false,
};

// ── Keyv official test suite ───────────────────────────────────────────

const store = () => new KeyvHana(hanaOptions);

keyvTestSuite(test, Keyv, store);
keyvIteratorTests(test, Keyv, store);

// ── Custom adapter tests ───────────────────────────────────────────────

test.beforeEach(async () => {
	const s = new KeyvHana(hanaOptions);
	await s.clear();
	await s.disconnect();
});

test.describe('KeyvHana', () => {
	test.it('should set and get a value', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'value1');
		const result = await s.get('key1');
		expect(result).toBe('value1');
		await s.disconnect();
	});

	test.it('should return undefined for missing key', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		const result = await s.get('nonexistent');
		expect(result).toBeUndefined();
		await s.disconnect();
	});

	test.it('should overwrite an existing key', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'first');
		await s.set('key1', 'second');
		const result = await s.get('key1');
		expect(result).toBe('second');
		await s.disconnect();
	});

	test.it('should delete an existing key and return true', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'value1');
		const deleted = await s.delete('key1');
		expect(deleted).toBe(true);
		const result = await s.get('key1');
		expect(result).toBeUndefined();
		await s.disconnect();
	});

	test.it('should return false when deleting a non-existent key', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		const deleted = await s.delete('nonexistent');
		expect(deleted).toBe(false);
		await s.disconnect();
	});

	test.it('should clear all keys', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'value1');
		await s.set('key2', 'value2');
		await s.clear();
		expect(await s.get('key1')).toBeUndefined();
		expect(await s.get('key2')).toBeUndefined();
		await s.disconnect();
	});

	test.it('should report has correctly', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'value1');
		expect(await s.has('key1')).toBe(true);
		expect(await s.has('nonexistent')).toBe(false);
		await s.disconnect();
	});

	test.it('should handle hasMany', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'v1');
		await s.set('key2', 'v2');
		const result = await s.hasMany(['key1', 'key2', 'key3']);
		expect(result).toEqual([true, true, false]);
		await s.disconnect();
	});

	test.it('should getMany', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'v1');
		await s.set('key2', 'v2');
		const result = await s.getMany(['key1', 'key2', 'missing']);
		expect(result).toEqual(['v1', 'v2', undefined]);
		await s.disconnect();
	});

	test.it('should setMany', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.setMany([
			{ key: 'a', value: '1' },
			{ key: 'b', value: '2' },
		]);
		expect(await s.get('a')).toBe('1');
		expect(await s.get('b')).toBe('2');
		await s.disconnect();
	});

	test.it('should deleteMany', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'v1');
		await s.set('key2', 'v2');
		const deleted = await s.deleteMany(['key1', 'key2']);
		expect(deleted).toBe(true);
		expect(await s.get('key1')).toBeUndefined();
		expect(await s.get('key2')).toBeUndefined();
		await s.disconnect();
	});

	test.it('should deleteMany return false when no keys exist', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		const deleted = await s.deleteMany(['nope1', 'nope2']);
		expect(deleted).toBe(false);
		await s.disconnect();
	});

	test.it('should iterate over entries', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('iter:key1', 'v1');
		await s.set('iter:key2', 'v2');
		await s.set('iter:key3', 'v3');

		const collected: Array<[string, string]> = [];
		for await (const entry of s.iterator('iter')) {
			collected.push(entry as [string, string]);
		}

		expect(collected).toHaveLength(3);
		const keys = collected.map(([k]) => k).sort();
		expect(keys).toEqual(['iter:key1', 'iter:key2', 'iter:key3']);
		await s.disconnect();
	});

	test.it('should work with Keyv', async ({ expect }) => {
		const keyv = new Keyv({ store: new KeyvHana(hanaOptions) });
		await keyv.set('foo', 'bar');
		expect(await keyv.get('foo')).toBe('bar');
		await keyv.delete('foo');
		expect(await keyv.get('foo')).toBeUndefined();
		await keyv.disconnect();
	});

	test.it('should support namespace via Keyv', async ({ expect }) => {
		const keyv = new Keyv({ store: new KeyvHana(hanaOptions), namespace: 'ns1' });
		await keyv.set('a', 'alpha');
		expect(await keyv.get('a')).toBe('alpha');
		await keyv.clear();
		expect(await keyv.get('a')).toBeUndefined();
		await keyv.disconnect();
	});

	test.it('should disconnect cleanly', async ({ expect }) => {
		const s = new KeyvHana(hanaOptions);
		await s.set('key1', 'value1');
		await s.disconnect();
		// After disconnect, operations should fail
		await expect(s.get('key1')).rejects.toThrow();
	});

});
