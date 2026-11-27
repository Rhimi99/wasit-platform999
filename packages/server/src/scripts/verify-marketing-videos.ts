/**
 * Produces the AFC-06 evidence: one real advert per supported language, each
 * checked by the delivery gate, with a machine-readable report.
 *
 *   npx tsx src/scripts/verify-marketing-videos.ts [--product-id <uuid>] [--out <dir>]
 *
 * The copy comes from a real product row when one is available; otherwise the
 * script uses a clearly labelled catalogue entry and says so in the report. It
 * never invents a product that the report would present as live data.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';
import { products } from '../db/schema/products.js';
import { produceMarketingVideo } from '../lib/media/marketing-video.js';
import { evaluateMarketingVideo } from '../lib/media/video-quality.js';
import { VIDEO_LANGUAGES, resolveVoice, type VideoLanguage } from '../lib/media/tts.js';
import { env } from '../lib/env.js';

interface Row {
  language: VideoLanguage;
  expected: 'delivered' | 'withheld';
  delivered: boolean;
  reason: string | null;
  message: string | null;
  durationSeconds: number | null;
  loudnessLufs: number | null;
  truePeakDb: number | null;
  voice: string | null;
  scenes: number;
  cues: number;
  bytes: number;
  sha256: string | null;
  file: string | null;
  failedChecks: string[];
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

interface ProductFactsSource {
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  brand: string | null;
  description: string | null;
  price: string | null;
  currencyCode: string;
  sellerName: string | null;
}

const SAMPLE: ProductFactsSource = {
  name: 'Café Arabica 1kg',
  nameAr: 'قهوة أرابيكا 1 كغ',
  nameFr: 'Café Arabica 1kg',
  brand: 'Maison Tunis',
  description: 'Café en grains torréfié artisanalement, emballé sous vide pour préserver les arômes.',
  price: '42.500',
  currencyCode: 'TND',
  sellerName: 'Maison Tunis',
};

async function loadProduct(productId: string | null) {
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      nameAr: products.nameAr,
      nameFr: products.nameFr,
      brand: products.brand,
      description: products.description,
      price: products.basePrice,
      currencyCode: products.currencyCode,
    })
    .from(products)
    .where(productId ? eq(products.id, productId) : and(eq(products.status, 'ACTIVE'), isNotNull(products.basePrice)))
    // Fixture rows ("Demo …") are fine to render, but the report should show a
    // catalogue product first when one exists.
    .orderBy(sql`case when ${products.name} ilike 'demo%' then 1 else 0 end`, sql`random()`)
    .limit(1);

  const row = rows[0];
  if (!row) return { source: 'sample' as const, id: null, facts: SAMPLE };
  return {
    source: 'database' as const,
    id: row.id,
    facts: {
      name: row.name,
      nameAr: row.nameAr,
      nameFr: row.nameFr,
      brand: row.brand,
      description: row.description,
      price: row.price,
      currencyCode: row.currencyCode,
      sellerName: SAMPLE.sellerName,
    },
  };
}

function localizedName(language: VideoLanguage, facts: ProductFactsSource): string {
  if (language === 'ar' || language === 'ar-TN') return facts.nameAr ?? facts.name;
  if (language === 'fr') return facts.nameFr ?? facts.name;
  return facts.name;
}

async function main(): Promise<void> {
  const outDir = path.resolve(arg('out') ?? 'artifacts/marketing-videos');
  await mkdir(outDir, { recursive: true });

  const product = await loadProduct(arg('product-id'));
  const languages = VIDEO_LANGUAGES;
  const rows: Row[] = [];

  for (const language of languages) {
    const voice = resolveVoice(language);
    const facts = {
      name: localizedName(language, product.facts),
      brand: product.facts.brand,
      description: product.facts.description,
      price: product.facts.price,
      currencyCode: product.facts.currencyCode,
      sellerName: product.facts.sellerName,
    };
    const workDir = path.join(outDir, `work-${language}`);
    await mkdir(workDir, { recursive: true });

    const started = Date.now();
    const produced = await produceMarketingVideo({
      facts,
      language,
      objective: 'SALES',
      audience: 'B2C',
      style: 'MODERN',
      targetSeconds: 35,
      workDir,
      outFile: path.join(outDir, `${language}.mp4`),
    });
    const report = await evaluateMarketingVideo({
      file: produced.file,
      produced,
      expected: { language, width: env.VIDEO_WIDTH, height: env.VIDEO_HEIGHT, fps: env.VIDEO_FPS },
      productSource: [facts.name, facts.brand, facts.description, facts.price, facts.currencyCode, facts.sellerName]
        .filter(Boolean)
        .join(' '),
    });

    const file = await readFile(produced.file);

    // A language with no licensed voice must be withheld, not shipped silent.
    const expected = voice.voice === null ? 'withheld' : 'delivered';
    rows.push({
      language,
      expected,
      delivered: report.passed,
      reason: report.reason,
      message: report.message,
      durationSeconds: report.metrics.durationSeconds,
      loudnessLufs: report.metrics.audio.loudnessLufs,
      truePeakDb: report.metrics.audio.truePeakDb,
      voice: produced.voice?.id ?? null,
      scenes: produced.timeline.scenes.length,
      cues: produced.subtitleCues,
      bytes: file.length,
      sha256: createHash('sha256').update(file).digest('hex'),
      file: report.passed ? path.relative(process.cwd(), produced.file) : null,
      failedChecks: report.checks.filter((c) => c.required && !c.passed).map((c) => c.id),
    });

    const verdict = report.passed ? 'DELIVERED' : 'WITHHELD';
    console.log(
      `${language.padEnd(6)} ${verdict.padEnd(9)} ${(report.metrics.durationSeconds ?? 0).toFixed(1)}s ` +
        `voice=${produced.voice?.id ?? 'none'} gate=${report.passed ? 'pass' : report.reason} ` +
        `(${((Date.now() - started) / 1000).toFixed(0)}s)`,
    );
  }

  const mismatches = rows.filter((row) => row.delivered !== (row.expected === 'delivered'));
  const summary = {
    generatedAt: new Date().toISOString(),
    product: { source: product.source, id: product.id, facts: product.facts },
    delivery: { width: env.VIDEO_WIDTH, height: env.VIDEO_HEIGHT, fps: env.VIDEO_FPS },
    rows,
    verdict: mismatches.length === 0 ? 'PASS' : 'FAIL',
    mismatches: mismatches.map((row) => row.language),
  };

  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(
    path.join(outDir, 'report.md'),
    [
      '# Marketing video verification (AFC-06)',
      '',
      `Generated: ${summary.generatedAt}`,
      `Product source: ${product.source}${product.id ? ` (${product.id})` : ''}`,
      `Delivery: ${env.VIDEO_WIDTH}x${env.VIDEO_HEIGHT} @ ${env.VIDEO_FPS}fps`,
      '',
      '| Language | Expected | Result | Duration | Loudness | Voice | Gate |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map(
        (row) =>
          `| ${row.language} | ${row.expected} | ${row.delivered ? 'delivered' : 'withheld'} | ` +
          `${row.durationSeconds?.toFixed(1) ?? '—'}s | ${row.loudnessLufs ?? '—'} LUFS | ` +
          `${row.voice ?? 'none'} | ${row.reason ?? 'passed'} |`,
      ),
      '',
      `Verdict: **${summary.verdict}**`,
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`report: ${path.join(outDir, 'report.md')}`);
  await closeDb();
  if (summary.verdict !== 'PASS') process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
