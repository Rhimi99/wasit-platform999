import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db } from '../src/db/client.js';
import { mediaAssets } from '../src/db/schema/media.js';
import { productImages } from '../src/db/schema/products.js';
import { probeImage, sniffImageType } from '../src/lib/media/image-probe.js';

const app = createApp();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Minimal but genuinely valid PNG (color type 2 = RGB), no external tools. */
function makePng(width: number, height: number, rgb: [number, number, number] = [24, 96, 180]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}-${Math.floor(Math.random() * 1e6)}`;
}

let ipSeq = 0;
const ipSubnet = Math.floor(Math.random() * 250) + 1;

function makeClient() {
  let cookie = '';
  ipSeq += 1;
  const ip = `198.19.${ipSubnet}.${(ipSeq % 250) + 1}`;
  async function send(
    path: string,
    options: { method?: string; body?: unknown; form?: FormData; raw?: Buffer; contentType?: string } = {},
  ) {
    const headers: Record<string, string> = { 'x-forwarded-for': ip };
    if (cookie) headers.Cookie = cookie;
    let body: RequestInit['body'] | undefined;
    if (options.form) body = options.form;
    else if (options.raw) {
      headers['Content-Type'] = options.contentType ?? 'application/octet-stream';
      body = new Uint8Array(options.raw);
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const res = await app.request(path, { method: options.method ?? 'GET', headers, body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie;
    const contentType = res.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await res.json().catch(() => null)
      : await res.arrayBuffer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { res, data: data as any, status: res.status, contentType };
  }
  return {
    req: send,
    upload(path: string, form: FormData) {
      return send(path, { method: 'POST', form });
    },
  };
}

type Client = ReturnType<typeof makeClient>;

async function register(client: Client, role = 'SUPPLIER') {
  const email = `img-${uniq(role.toLowerCase())}@wasit.tn`;
  const reg = await client.req('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', firstName: 'Image', role },
  });
  expect(reg.status).toBe(201);
  const login = await client.req('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'StrongPass123!', allowUnverifiedEmail: true },
  });
  expect(login.status).toBe(200);
  return email;
}

async function createProduct(client: Client, role: 'SUPPLIER' | 'MERCHANT' = 'SUPPLIER') {
  const entity =
    role === 'SUPPLIER'
      ? await client.req('/api/suppliers', {
          method: 'POST',
          body: { companyName: `Image Supplier ${uniq('s')}` },
        })
      : await client.req('/api/merchants', {
          method: 'POST',
          body: { storeName: `Image Merchant ${uniq('m')}` },
        });
  expect(entity.status).toBe(201);
  const sellerId = entity.data.data.id as string;

  const cats = await client.req('/api/categories');
  const categoryId = (cats.data.data as Array<{ id: string }>)[0].id;

  const product = await client.req('/api/products', {
    method: 'POST',
    body: {
      sellerId,
      sellerType: role,
      sku: uniq('IMG-SKU'),
      categoryId,
      name: `Photo Product ${uniq('p')}`,
      description: 'A product used to exercise the image pipeline.',
      basePrice: '19.9000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 25,
      lowStockThreshold: 5,
    },
  });
  expect(product.status).toBe(201);
  const productId = product.data.data.id as string;

  const activated = await client.req(`/api/products/${productId}/status`, {
    method: 'PATCH',
    body: { status: 'ACTIVE' },
  });
  expect(activated.status).toBe(200);

  return { sellerId, productId };
}

async function sellerWithProduct(role: 'SUPPLIER' | 'MERCHANT' = 'SUPPLIER') {
  const client = makeClient();
  await register(client, role);
  const { sellerId, productId } = await createProduct(client, role);
  return { client, sellerId, productId };
}

function imageForm(productId: string, bytes: Buffer, filename = 'photo.png', extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set('productId', productId);
  form.set('file', new File([new Uint8Array(bytes)], filename, { type: 'image/png' }));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return form;
}

async function imageCount(productId: string): Promise<number> {
  const rows = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(eq(mediaAssets.productId, productId));
  return rows.length;
}

// ---------------------------------------------------------------------------
// Probe unit coverage
// ---------------------------------------------------------------------------

describe('image probe', () => {
  it('identifies a real PNG and reads its dimensions', () => {
    const probe = probeImage(makePng(320, 180));
    expect(probe).toEqual({ mimeType: 'image/png', extension: 'png', width: 320, height: 180 });
  });

  it('refuses HTML, SVG and truncated headers', () => {
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
    expect(probeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]))).toBeNull();
  });

  it('reads JPEG and WebP dimensions from their headers', () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x02, 0x00, 0xf0, 0x03]),
      Buffer.alloc(9),
    ]);
    expect(probeImage(jpeg)).toMatchObject({ mimeType: 'image/jpeg', width: 240, height: 258 });

    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'latin1');
    vp8x.write('WEBP', 8, 'latin1');
    vp8x.write('VP8X', 12, 'latin1');
    vp8x.writeUIntLE(299, 24, 3);
    vp8x.writeUIntLE(199, 27, 3);
    expect(probeImage(vp8x)).toMatchObject({ mimeType: 'image/webp', width: 300, height: 200 });
  });
});

// ---------------------------------------------------------------------------
// Upload / link / render / delete
// ---------------------------------------------------------------------------

describe('product images', { timeout: 120_000 }, () => {
  it('uploads a real PNG, links it to the product and publishes it to the storefront', async () => {
    const { client, productId } = await sellerWithProduct();

    const png = makePng(640, 400);
    const uploaded = await client.upload('/api/media/product-images', imageForm(productId, png));
    expect(uploaded.status).toBe(201);
    expect(uploaded.data.success).toBe(true);

    const image = uploaded.data.data as {
      id: string;
      url: string;
      isPrimary: boolean;
      width: number;
      height: number;
      sizeBytes: number;
      mimeType: string;
    };
    expect(image.mimeType).toBe('image/png');
    expect(image.width).toBe(640);
    expect(image.height).toBe(400);
    expect(image.isPrimary).toBe(true);
    expect(image.url).toBe(`/api/media/products/${productId}/images/${image.id}/content`);

    // The storage key is internal: it must never appear in a client payload.
    const payload = JSON.stringify(uploaded.data);
    expect(payload).not.toContain('storageKey');
    expect(payload).not.toContain('storage_key');
    expect(payload).not.toContain('.wasit-media');

    // Linked in product_images, and surfaced by the detail projection.
    const detail = await client.req(`/api/products/${productId}`);
    expect(detail.status).toBe(200);
    const images = detail.data.data.images as Array<{ url: string; isPrimary: boolean; altText: string | null }>;
    expect(images).toHaveLength(1);
    expect(images[0].url).toBe(image.url);
    expect(images[0].isPrimary).toBe(true);

    // The public list exposes it as the card image.
    const list = await client.req(`/api/products?page=1&pageSize=50`);
    expect(list.status).toBe(200);
    const card = (list.data.data.items as Array<{ id: string; image: string | null }>).find((p) => p.id === productId);
    expect(card?.image).toBe(image.url);

    // The public content endpoint serves the real bytes without a session.
    const publicFetch = makeClient();
    const content = await publicFetch.req(image.url);
    expect(content.status).toBe(200);
    expect(content.contentType).toContain('image/png');
    const bytes = Buffer.from(content.data as ArrayBuffer);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, image.id));
    expect(row.kind).toBe('IMAGE');
    expect(row.status).toBe('READY');
    expect(row.storageKey).toBeTruthy();
  });

  it('refuses an HTML file renamed to .png (content, not extension)', async () => {
    const { client, productId } = await sellerWithProduct();
    const fake = Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>');

    const res = await client.upload('/api/media/product-images', imageForm(productId, fake, 'innocent.png'));
    expect(res.status).toBe(422);
    expect(res.data.error.code).toBe('UNPROCESSABLE_ENTITY');
    expect(await imageCount(productId)).toBe(0);
  });

  it('refuses SVG payloads even when declared as an image', async () => {
    const { client, productId } = await sellerWithProduct();
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    const form = new FormData();
    form.set('productId', productId);
    form.set('file', new File([new Uint8Array(svg)], 'vector.png', { type: 'image/svg+xml' }));

    const res = await client.upload('/api/media/product-images', form);
    expect(res.status).toBe(422);
    expect(await imageCount(productId)).toBe(0);
  });

  it('refuses a file larger than the configured limit', async () => {
    const { client, productId } = await sellerWithProduct();
    // A valid PNG header followed by padding: the size check must fire first.
    // Sent with an explicit length (as a browser does) so the guard rejects the
    // body before it is buffered.
    const oversized = Buffer.concat([makePng(32, 32), Buffer.alloc(6 * 1024 * 1024)]);
    const res = await client.req('/api/media/product-images', {
      method: 'POST',
      raw: oversized,
      contentType: 'multipart/form-data; boundary=wasit-test',
    });
    expect(res.status).toBe(413);
    expect(await imageCount(productId)).toBe(0);
  });

  it('refuses a merchant uploading to another merchant’s product', async () => {
    const owner = await sellerWithProduct('MERCHANT');
    const intruder = makeClient();
    await register(intruder, 'MERCHANT');
    await createProduct(intruder, 'MERCHANT');

    const res = await intruder.upload('/api/media/product-images', imageForm(owner.productId, makePng(64, 64)));
    expect(res.status).toBe(403);
    expect(await imageCount(owner.productId)).toBe(0);
  });

  it('refuses a CUSTOMER uploading product images (RBAC, not UI-only)', async () => {
    const customer = makeClient();
    await register(customer, 'CUSTOMER');
    const { productId } = await sellerWithProduct();

    const res = await customer.upload('/api/media/product-images', imageForm(productId, makePng(64, 64)));
    expect(res.status).toBe(403);
    expect(await imageCount(productId)).toBe(0);
  });

  it('refuses an unauthenticated upload', async () => {
    const { productId } = await sellerWithProduct();
    const anon = makeClient();
    const res = await anon.upload('/api/media/product-images', imageForm(productId, makePng(32, 32)));
    expect(res.status).toBe(401);
  });

  it('enforces the per-product image limit', async () => {
    const { client, productId } = await sellerWithProduct();
    for (let i = 0; i < 8; i += 1) {
      const res = await client.upload('/api/media/product-images', imageForm(productId, makePng(24, 24)));
      expect(res.status).toBe(201);
    }
    const ninth = await client.upload('/api/media/product-images', imageForm(productId, makePng(24, 24)));
    expect(ninth.status).toBe(422);
    expect(await imageCount(productId)).toBe(8);
  });

  it('deletes an image, promotes the next cover and keeps the product intact', async () => {
    const { client, productId } = await sellerWithProduct();

    const first = await client.upload('/api/media/product-images', imageForm(productId, makePng(40, 30)));
    expect(first.status).toBe(201);
    const second = await client.upload(
      '/api/media/product-images',
      imageForm(productId, makePng(50, 40), 'second.png', { isPrimary: 'true' }),
    );
    expect(second.status).toBe(201);
    expect((second.data.data as { isPrimary: boolean }).isPrimary).toBe(true);

    const firstId = (first.data.data as { id: string }).id;
    const secondId = (second.data.data as { id: string }).id;

    const removed = await client.req(`/api/media/product-images/${secondId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);

    const detail = await client.req(`/api/products/${productId}`);
    expect(detail.status).toBe(200);
    const images = detail.data.data.images as Array<{ url: string; isPrimary: boolean }>;
    expect(images).toHaveLength(1);
    expect(images[0].isPrimary).toBe(true);
    expect(images[0].url).toContain(firstId);

    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, secondId));
    expect(asset.status).toBe('DELETED');
    expect(asset.storageKey).toBeNull();

    // The deleted image is gone from the public endpoint too.
    const anon = makeClient();
    const gone = await anon.req(`/api/media/products/${productId}/images/${secondId}/content`);
    expect(gone.status).toBe(404);
  });

  it('refuses deleting an image that belongs to another seller', async () => {
    const owner = await sellerWithProduct('MERCHANT');
    const uploaded = await owner.client.upload('/api/media/product-images', imageForm(owner.productId, makePng(48, 48)));
    const imageId = (uploaded.data.data as { id: string }).id;

    const intruder = makeClient();
    await register(intruder, 'MERCHANT');
    await createProduct(intruder, 'MERCHANT');

    const res = await intruder.req(`/api/media/product-images/${imageId}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    const [asset] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, imageId));
    expect(asset.status).toBe('READY');
  });

  it('switches the cover to another image', async () => {
    const { client, productId } = await sellerWithProduct();
    const a = await client.upload('/api/media/product-images', imageForm(productId, makePng(30, 30)));
    const b = await client.upload('/api/media/product-images', imageForm(productId, makePng(30, 30), 'b.png'));
    const aId = (a.data.data as { id: string }).id;
    const bId = (b.data.data as { id: string }).id;

    const promoted = await client.req(`/api/media/product-images/${bId}/primary`, { method: 'PATCH' });
    expect(promoted.status).toBe(200);
    expect((promoted.data.data as { isPrimary: boolean }).isPrimary).toBe(true);

    const rows = await db.select().from(productImages).where(eq(productImages.productId, productId));
    expect(rows.filter((r) => r.isPrimary).map((r) => r.url)).toEqual([
      `/api/media/products/${productId}/images/${bId}/content`,
    ]);
    expect(rows.some((r) => r.url.includes(aId))).toBe(true);
  });

  it('serves an unpublished product image to its owner but not to anyone else', async () => {
    const { client, productId } = await sellerWithProduct();
    const uploaded = await client.upload('/api/media/product-images', imageForm(productId, makePng(30, 30)));
    const url = (uploaded.data.data as { url: string }).url;

    const deactivated = await client.req(`/api/products/${productId}/status`, {
      method: 'PATCH',
      body: { status: 'INACTIVE' },
    });
    expect(deactivated.status).toBe(200);

    // Anonymous: the draft's photos are not enumerable.
    const anon = makeClient();
    const anonymous = await anon.req(url);
    expect(anonymous.status).toBe(404);

    // A different seller: also refused.
    const stranger = makeClient();
    await register(stranger, 'SUPPLIER');
    await createProduct(stranger, 'SUPPLIER');
    expect((await stranger.req(url)).status).toBe(404);

    // The owner's dashboard renders the same URL, so it keeps working.
    const owned = await client.req(url);
    expect(owned.status).toBe(200);
    expect(owned.res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects a non-multipart body and a traversal-style file name', async () => {
    const { client, productId } = await sellerWithProduct();

    const asJson = await client.req('/api/media/product-images', {
      method: 'POST',
      body: { productId },
    });
    expect(asJson.status).toBe(422);
    expect(asJson.data.error.code).toBe('VALIDATION_ERROR');

    const traversal = await client.upload(
      '/api/media/product-images',
      imageForm(productId, makePng(20, 20), '../../etc/passwd.png'),
    );
    expect(traversal.status).toBe(422);
    expect(await imageCount(productId)).toBe(0);
  });

  it('downscales a large photo to the display bound before storing it', async () => {
    const { client, productId } = await sellerWithProduct();
    const large = makePng(3200, 2400);
    const res = await client.upload('/api/media/product-images', imageForm(productId, large));
    expect(res.status).toBe(201);

    const image = res.data.data as { id: string; width: number; height: number };
    expect(image.width).toBe(1600);
    expect(image.height).toBe(1200);

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, image.id));
    expect(row.provider).toBe('ffmpeg');
    expect(row.sizeBytes).toBeLessThan(large.length);
  });

  it('lists only the caller’s own product images', async () => {
    const owner = await sellerWithProduct();
    await owner.client.upload('/api/media/product-images', imageForm(owner.productId, makePng(26, 26)));

    const listed = await owner.client.req(`/api/media/product-images?productId=${owner.productId}`);
    expect(listed.status).toBe(200);
    expect((listed.data.data.items as unknown[]).length).toBe(1);

    const intruder = makeClient();
    await register(intruder, 'SUPPLIER');
    await createProduct(intruder, 'SUPPLIER');
    const denied = await intruder.req(`/api/media/product-images?productId=${owner.productId}`);
    expect(denied.status).toBe(403);
  });
});
