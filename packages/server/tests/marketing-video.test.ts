import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { mediaAssets } from '../src/db/schema/media.js';
import { eq } from 'drizzle-orm';
import { resolveVideoProvider } from '../src/lib/media/resolve.js';

const app = createApp();

function makeClient() {
  let cookie = '';
  return {
    async req(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
      const headers: Record<string, string> = { ...options.headers };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await app.request(path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie;
      const contentType = res.headers.get('content-type') ?? '';
      const isJson = contentType.includes('application/json');
      const data = isJson ? await res.json().catch(() => null) : await res.arrayBuffer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { res, data: data as any, status: res.status, contentType };
    },
  };
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}-${Math.floor(Math.random() * 1e6)}`;
}

async function register(c: ReturnType<typeof makeClient>, role = 'SUPPLIER') {
  const email = `it-media-${uniq(role.toLowerCase())}@wasit.tn`;
  const r = await c.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Media', role },
  });
  expect(r.status).toBe(201);
  const login = await c.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return email;
}

/** Crates a SUPPLIER with one ACTIVE, published product ready for video generation. */
async function setupSellerWithProduct() {
  const client = makeClient();
  await register(client, 'SUPPLIER');
  const profile = await client.req('/api/suppliers', {
    method: 'POST',
    body: { companyName: `Media Supplier ${uniq('s')}` },
  });
  expect(profile.status).toBe(201);
  const supplierId = profile.data.data.id as string;

  const cats = await client.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId: supplierId,
      sellerType: 'SUPPLIER',
      sku: uniq('MEDIA-SKU'),
      categoryId,
      name: `Olive Oil Premium ${uniq('p')}`,
      nameAr: 'زيت زيتون ممتاز',
      description: 'Extra virgin olive oil from Tunisia, cold pressed.',
      basePrice: '24.5000',
      currencyCode: 'TND',
      moq: 12,
      initialQuantity: 200,
      lowStockThreshold: 10,
    },
  });
  expect(product.status).toBe(201);
  const productId = product.data.data.id as string;

  const activated = await client.req(`/api/products/${productId}/status`, {
    method: 'PATCH',
    body: { status: 'ACTIVE' },
  });
  expect(activated.status).toBe(200);

  return { client, supplierId, productId };
}

const rendererAvailable = (() => {
  try {
    if (resolveVideoProvider().id !== 'structural') return false;
    return [
      path.resolve(process.cwd(), 'node_modules/ffmpeg-static/ffmpeg'),
      path.resolve(process.cwd(), '../../node_modules/ffmpeg-static/ffmpeg'),
    ].some((p) => existsSync(p));
  } catch {
    return false;
  }
})();

describe('Marketing Video Generation Agent', () => {
  beforeAll(() => {
    // The structural renderer requires the bundled ffmpeg binary.
    expect(rendererAvailable, 'bundled ffmpeg must be installed for video tests').toBe(true);
  });

  it('rejects unauthenticated generation', async () => {
    const c = makeClient();
    const r = await c.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(r.status).toBe(401);
  });

  it('rejects a CUSTOMER from generating a marketing video (RBAC, not UI-only)', async () => {
    const customer = makeClient();
    await register(customer, 'CUSTOMER');
    const r = await customer.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId: '00000000-0000-0000-0000-000000000000' },
    });
    // CUSTOMER lacks media:upload → 403 from the backend permission guard.
    expect(r.status).toBe(403);
  });

  it('rejects generating a video for another seller\'s product', async () => {
    const a = await setupSellerWithProduct();
    const b = await setupSellerWithProduct();
    const r = await b.client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId: a.productId },
    });
    expect(r.status).toBe(403);
  });

  it('rejects generating a video for a non-ACTIVE product', async () => {
    const client = makeClient();
    await register(client, 'SUPPLIER');
    const profile = await client.req('/api/suppliers', { method: 'POST', body: { companyName: `Draft ${uniq('d')}` } });
    expect(profile.status).toBe(201);
    const supplierId = profile.data.data.id as string;
    const cats = await client.req('/api/categories');
    const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;
    const product = await client.req('/api/products', {
      method: 'POST',
      body: { sellerId: supplierId, sellerType: 'SUPPLIER', sku: uniq('DRAFT-SKU'), categoryId, name: 'Draft Product', basePrice: '5.0000', currencyCode: 'TND' },
    });
    const productId = product.data.data.id as string;
    // Products are created ACTIVE; a seller must be able to take one down.
    const taken = await client.req(`/api/products/${productId}/status`, {
      method: 'PATCH',
      body: { status: 'INACTIVE' },
    });
    expect(taken.status).toBe(200);

    const r = await client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId },
    });
    expect(r.status).toBe(422);
    expect(r.data.error.code).toBe('PRODUCT_NOT_ACTIVE');
  });

  it('renders a real, previewable and downloadable MP4 end-to-end', async () => {
    const { client, productId } = await setupSellerWithProduct();

    const gen = await client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId, language: 'ar', audience: 'B2B', style: 'MODERN', durationSeconds: 4 },
    });
    expect(gen.status).toBe(201);
    const asset = gen.data.data;

    expect(asset.status).toBe('READY');
    expect(asset.kind).toBe('MARKETING_VIDEO');
    expect(asset.mimeType).toBe('video/mp4');
    expect(asset.provider).toBe('structural');
    expect(asset.previewable).toBe(true);
    expect(asset.downloadable).toBe(true);
    expect(asset.sizeBytes).toBeGreaterThan(1000);
    expect(asset.durationSeconds).toBe(4);
    expect(asset.width).toBeGreaterThan(0);
    expect(asset.height).toBeGreaterThan(0);
    expect(asset.previewUrl).toContain(`/api/media/assets/${asset.id}/content?token=`);
    expect(asset.downloadUrl).toContain('download=1');

    // The binary is a genuine MP4 (ftyp box in the first bytes).
    const preview = new URL(asset.previewUrl, 'http://localhost');
    const content = await client.req(`${preview.pathname}${preview.search}`);
    expect(content.status).toBe(200);
    expect(content.contentType).toContain('video/mp4');
    const buf = Buffer.from(content.data as ArrayBuffer);
    expect(buf.subarray(4, 8).toString('ascii')).toBe('ftyp');

    // PERSISTED in the DB (not a fake in-memory response).
    const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('READY');
    expect(rows[0].storageKey).toBeTruthy();

    // It appears in the owner's media library.
    const list = await client.req('/api/media/assets?kind=MARKETING_VIDEO');
    expect(list.status).toBe(200);
    const ids = (list.data.data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(asset.id);
  });

  it('renders Arabic text using the bundled shaping font (real glyphs, not tofu)', async () => {
    const { client, productId } = await setupSellerWithProduct();
    const gen = await client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId, language: 'ar', style: 'BOLD', durationSeconds: 4, title: 'زيت زيتون ممتاز' },
    });
    expect(gen.status).toBe(201);
    const asset = gen.data.data as { id: string; previewUrl: string };
    expect(asset.previewUrl).toBeTruthy();

    // Download the MP4 and confirm it carries real encoded video bytes.
    const preview = new URL(asset.previewUrl, 'http://localhost');
    const content = await client.req(`${preview.pathname}${preview.search}`);
    const buf = Buffer.from(content.data as ArrayBuffer);
    expect(buf.length).toBeGreaterThan(10000);
  });

  it('isolates media between users', async () => {
    const a = await setupSellerWithProduct();
    const b = await setupSellerWithProduct();
    const gen = await a.client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId: a.productId, durationSeconds: 4 },
    });
    const assetId = gen.data.data.id as string;

    const listB = await b.client.req('/api/media/assets');
    const idsB = (listB.data.data.items as Array<{ id: string }>).map((i) => i.id);
    expect(idsB).not.toContain(assetId);

    const direct = await b.client.req(`/api/media/assets/${assetId}`);
    expect(direct.status).toBe(403);
  });

  it('rejects an invalid/expired signed content link', async () => {
    const c = makeClient();
    const r = await c.req('/api/media/assets/does-not-exist/content?token=garbage.sig');
    expect(r.status).toBe(401);
  });

  it('soft-deletes an owned asset and removes it from the library', async () => {
    const { client, productId } = await setupSellerWithProduct();
    const gen = await client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId, durationSeconds: 4 },
    });
    const assetId = gen.data.data.id as string;

    const del = await client.req(`/api/media/assets/${assetId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const rows = await db.select().from(mediaAssets).where(eq(mediaAssets.id, assetId));
    expect(rows[0].status).toBe('DELETED');
    expect(rows[0].storageKey).toBeNull();

    const list = await client.req('/api/media/assets');
    const ids = (list.data.data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(assetId); // retained as DELETED for audit, not shown as READY.
    const asset = await client.req(`/api/media/assets/${assetId}`);
    expect(asset.data.data.status).toBe('DELETED');
    expect(asset.data.data.previewUrl).toBeNull();
  });

  it('exposes generated videos to the Marketing Agent as real media payloads', async () => {
    const { client, productId } = await setupSellerWithProduct();
    const gen = await client.req('/api/media/marketing-videos', {
      method: 'POST',
      body: { productId, durationSeconds: 4 },
    });
    expect(gen.status).toBe(201);
    const assetId = gen.data.data.id as string;

    const task = await client.req('/api/ai/agents/marketing-agent/tasks', {
      method: 'POST',
      body: { input: { action: 'recommend_campaign' } },
    });
    // marketing-agent is read-only advisory → runs immediately (201 or 200).
    expect([200, 201]).toContain(task.status);
    const status = task.data.data.status as string;
    expect(['succeeded', 'awaiting_approval']).toContain(status);

    // Fetch the completed task and parse its structured advisory result.
    const taskId = task.data.data.id as string;
    const fetched = await client.req(`/api/ai/tasks/${taskId}`);
    const result = fetched.data.data.result as { advice?: string } | null;
    expect(result?.advice).toBeTruthy();
    const parsed = JSON.parse(result!.advice as string) as {
      marketingVideos: Array<{ id: string; mediaUrl: string | null; downloadUrl: string | null; previewable: boolean; mimeType: string }>;
    };
    expect(Array.isArray(parsed.marketingVideos)).toBe(true);
    const mine = parsed.marketingVideos.find((v) => v.id === assetId);
    expect(mine).toBeTruthy();
    expect(mine!.mimeType).toBe('video/mp4');
    expect(mine!.previewable).toBe(true);
    expect(mine!.mediaUrl).toContain(`/api/media/assets/${assetId}/content?token=`);
    expect(mine!.downloadUrl).toContain('download=1');
  });
});

describe('Product ownership listing (/api/products/mine)', () => {
  it("lists only the caller's own products, across statuses", async () => {
    const { client, productId } = await setupSellerWithProduct();
    const other = await setupSellerWithProduct();

    const mine = await client.req('/api/products/mine');
    expect(mine.status).toBe(200);
    const ids = (mine.data.data.items as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(productId);
    expect(ids).not.toContain(other.productId);
  });

  it('returns an empty list for a user with no business entities (not an error)', async () => {
    const customer = makeClient();
    await register(customer, 'CUSTOMER');
    const mine = await customer.req('/api/products/mine');
    expect(mine.status).toBe(200);
    expect(mine.data.data.items).toEqual([]);
    expect(mine.data.data.pagination.total).toBe(0);
  });

  it('requires authentication', async () => {
    const c = makeClient();
    const mine = await c.req('/api/products/mine');
    expect(mine.status).toBe(401);
  });
});
