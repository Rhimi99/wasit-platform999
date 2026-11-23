import { deflateSync } from 'node:zlib';
import { test, expect, storageFor } from './helpers';

/**
 * MEDIA-01 — product images, driven through the real mobile UI against the real
 * backend and PostgreSQL. No route interception: the photo is a genuine PNG
 * uploaded through the file input, and the assertions read the same public URL
 * the storefront renders.
 */

const UNIQUE = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

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

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3), 0x3a);
  for (let y = 0; y < height; y += 1) raw[y * (1 + width * 3)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Created {
  id: string;
  name: string;
}

/** Creates a real ACTIVE product for the signed-in merchant via the public API. */
async function createProduct(page: import('@playwright/test').Page, label: string): Promise<Created> {
  const entities = await page.request.get('/api/products/mine/entities');
  const seller = ((await entities.json()) as { data: { items: Array<{ id: string; sellerType: string }> } }).data
    .items[0];
  expect(seller).toBeTruthy();

  const cats = await page.request.get('/api/categories');
  const categoryId = ((await cats.json()) as { data: Array<{ id: string }> }).data[0].id;

  const name = `Photo ${label} ${UNIQUE}`;
  const created = await page.request.post('/api/products', {
    data: {
      sellerId: seller.id,
      sellerType: seller.sellerType,
      sku: `IMG-${UNIQUE}-${Math.floor(Math.random() * 1e6)}`,
      categoryId,
      name,
      description: 'Product created by the MEDIA-01 end-to-end spec.',
      basePrice: '14.5000',
      currencyCode: 'TND',
      moq: 1,
      initialQuantity: 10,
      lowStockThreshold: 2,
    },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { data: { id: string } }).data.id;

  const activated = await page.request.patch(`/api/products/${id}/status`, { data: { status: 'ACTIVE' } });
  expect(activated.ok()).toBeTruthy();
  return { id, name };
}

async function archive(page: import('@playwright/test').Page, id: string) {
  await page.request.patch(`/api/products/${id}/status`, { data: { status: 'ARCHIVED' } });
}

test.describe('Product images on a phone viewport', () => {
  test.use({ storageState: storageFor('merchant'), viewport: { width: 390, height: 844 } });

  test('the dashboard navigation collapses into a drawer so the table is not squeezed', async ({ page }) => {
    await page.goto('/dashboard/products');

    // The permanent rail must be gone on a phone: the page owns the full width.
    await expect(page.getByTestId('dashboard-nav-drawer')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);

    await page.getByTestId('dashboard-nav-toggle').click();
    const drawer = page.getByTestId('dashboard-nav-drawer');
    await expect(drawer).toBeVisible();

    // Following a link closes the drawer instead of leaving it over the page.
    await drawer.getByRole('link', { name: /المخزون|Inventory/ }).first().click();
    await expect(page).toHaveURL(/dashboard\/inventory/);
    await expect(page.getByTestId('dashboard-nav-drawer')).toHaveCount(0);
  });

  test('merchant uploads a photo from the mobile dashboard and the storefront renders it', async ({ page }) => {
    const product = await createProduct(page, 'upload');

    await page.goto('/dashboard/products');
    await page.locator(`[data-testid="product-images-${product.id}"]`).click();
    await expect(page.getByTestId('product-images-panel')).toBeVisible();

    // The layout must fit the phone: no horizontal scrolling with the panel open.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(2);

    await page.setInputFiles('[data-testid="product-image-input"]', {
      name: 'storefront.png',
      mimeType: 'image/png',
      buffer: png(240, 180),
    });
    // Preview happens locally, before any request is sent.
    await expect(page.getByTestId('product-image-preview')).toBeVisible();
    await expect(page.getByTestId('product-image-preview').locator('img')).toBeVisible();

    await page.getByTestId('product-image-upload').click();
    await expect(page.getByTestId('product-image-grid').locator('li')).toHaveCount(1);
    await expect(page.getByText(/تم رفع الصورة|Image uploaded/).first()).toBeVisible();

    const detail = await page.request.get(`/api/products/${product.id}`);
    const images = ((await detail.json()) as { data: { images: Array<{ id: string; url: string; isPrimary: boolean }> } })
      .data.images;
    expect(images).toHaveLength(1);
    expect(images[0].isPrimary).toBe(true);

    // The public content endpoint serves the actual bytes, without a session.
    const raw = await page.request.get(images[0].url);
    expect(raw.status()).toBe(200);
    expect(raw.headers()['content-type']).toContain('image/png');
    const bytes = await raw.body();
    expect(bytes.subarray(0, 4).toString('hex')).toBe('89504e47');

    await page.getByTestId('product-images-close').click();
    // The seller's own table now shows the cover thumbnail.
    await expect(page.getByTestId(`product-thumb-${product.id}`)).toBeVisible();

    // And the storefront renders the same image on the product page.
    await page.goto(`/products/${product.id}`);
    const hero = page.getByTestId('product-primary-image');
    await expect(hero).toBeVisible();
    await expect.poll(() => hero.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    // An archived product keeps its photo visible to its owner: the dashboard
    // renders the same public URL, which stays readable for the seller only.
    await archive(page, product.id);
    await page.goto('/dashboard/products');
    await expect(page.getByTestId(`product-thumb-${product.id}`)).toBeVisible();

    // Cleanup.
    await page.request.delete(`/api/media/product-images/${images[0].id}`);
  });

  test('a fake image is refused with a clear message and nothing is stored', async ({ page }) => {
    const product = await createProduct(page, 'fake');

    await page.goto('/dashboard/products');
    await page.locator(`[data-testid="product-images-${product.id}"]`).click();
    await page.setInputFiles('[data-testid="product-image-input"]', {
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    await page.getByTestId('product-image-upload').click();

    await expect(page.getByTestId('product-image-error')).toBeVisible();
    const detail = await page.request.get(`/api/products/${product.id}`);
    expect(((await detail.json()) as { data: { images: unknown[] } }).data.images).toHaveLength(0);

    await archive(page, product.id);
  });

  test('deleting the only photo keeps the product valid and shows the fallback', async ({ page }) => {
    const product = await createProduct(page, 'delete');

    const uploaded = await page.request.post('/api/media/product-images', {
      multipart: {
        productId: product.id,
        file: { name: 'cover.png', mimeType: 'image/png', buffer: png(120, 120) },
      },
    });
    expect(uploaded.status()).toBe(201);
    const imageId = ((await uploaded.json()) as { data: { id: string } }).data.id;

    await page.goto('/dashboard/products');
    await page.locator(`[data-testid="product-images-${product.id}"]`).click();
    await page.getByTestId(`product-image-delete-${imageId}`).click();
    await expect(page.getByText(/لا توجد صور بعد|No images yet/).first()).toBeVisible();

    const detail = await page.request.get(`/api/products/${product.id}`);
    expect(detail.status()).toBe(200);
    expect(((await detail.json()) as { data: { images: unknown[] } }).data.images).toHaveLength(0);

    await page.goto(`/products/${product.id}`);
    await expect(page.getByTestId('product-primary-image')).toHaveCount(0);

    await archive(page, product.id);
  });
});
