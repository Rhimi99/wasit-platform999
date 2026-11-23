import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiCall } from '@/lib/api';
import { useI18n } from '@/lib/i18n-context';
import type { ProductImageRow } from '@/lib/types';
import { EmptyState, Spinner } from './ui';

/** Mirrors the server ceiling; the server re-checks everything. */
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 8;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

interface Props {
  productId: string;
  productName: string;
  onClose: () => void;
  /** Called after a change so the product list can refresh its card image. */
  onChanged: () => void;
}

/**
 * Product image manager: pick → preview → upload, then cover/delete.
 *
 * The preview is a local object URL created before any request, so the seller
 * sees exactly what will be uploaded. Type and size are checked here for a
 * fast, translated message; the server still sniffs the real bytes, enforces
 * ownership and re-applies both limits.
 */
export function ProductImageManager({ productId, productName, onClose, onChanged }: Props) {
  const { t } = useI18n();
  const [images, setImages] = useState<ProductImageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ file: File; previewUrl: string } | null>(null);
  const [altText, setAltText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiCall(() => api.listProductImages(productId));
    setImages(res.data?.items ?? []);
    if (res.error) setError(res.error);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Revoke the object URL when the panel closes or the preview is replaced.
  useEffect(() => () => {
    if (pending) URL.revokeObjectURL(pending.previewUrl);
  }, [pending]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function clearPending() {
    if (pending) URL.revokeObjectURL(pending.previewUrl);
    setPending(null);
    setAltText('');
    if (inputRef.current) inputRef.current.value = '';
  }

  function pick(file: File | undefined) {
    setError(null);
    setNotice(null);
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) {
      setError(t('productImages.wrongType'));
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(t('productImages.tooLarge'));
      return;
    }
    if (images.length >= MAX_IMAGES) {
      setError(t('productImages.limit'));
      return;
    }
    if (pending) URL.revokeObjectURL(pending.previewUrl);
    setPending({ file, previewUrl: URL.createObjectURL(file) });
  }

  async function upload() {
    if (!pending) return;
    setBusy('upload');
    setError(null);
    const res = await apiCall(() =>
      api.uploadProductImage(productId, pending.file, { altText: altText.trim() || undefined }),
    );
    setBusy(null);
    if (res.error) {
      setError(res.error);
      return;
    }
    clearPending();
    setNotice(t('productImages.uploaded'));
    await load();
    onChanged();
  }

  async function makeCover(id: string) {
    setBusy(id);
    setError(null);
    const res = await apiCall(() => api.setPrimaryProductImage(id));
    setBusy(null);
    if (res.error) {
      setError(res.error);
      return;
    }
    await load();
    onChanged();
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    const res = await apiCall(() => api.deleteProductImage(id));
    setBusy(null);
    if (res.error) {
      setError(res.error);
      return;
    }
    setNotice(t('productImages.deleted'));
    await load();
    onChanged();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      data-testid="product-images-panel"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('productImages.title')}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:max-w-2xl sm:rounded-xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-800">{t('productImages.title')}</h3>
            <p className="text-xs text-slate-500">{productName}</p>
          </div>
          <button
            type="button"
            className="btn-secondary min-h-11 px-3 text-sm"
            onClick={onClose}
            data-testid="product-images-close"
          >
            {t('common.close')}
          </button>
        </div>

        <p className="mb-3 text-xs text-slate-500">{t('productImages.hint')}</p>

        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            ref={inputRef}
            id="product-image-file"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            data-testid="product-image-input"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <label htmlFor="product-image-file" className="btn-secondary min-h-11 cursor-pointer text-center text-sm">
            {t('productImages.choose')}
          </label>
          <span className="text-xs text-slate-400">{t('productImages.types')}</span>
        </div>

        {pending && (
          <div className="mb-4 rounded-lg border border-slate-200 p-3" data-testid="product-image-preview">
            <div className="flex flex-col gap-3 sm:flex-row">
              <img
                src={pending.previewUrl}
                alt={t('productImages.preview')}
                className="h-32 w-full rounded object-cover sm:w-40"
              />
              <div className="flex flex-1 flex-col gap-2">
                <label className="label" htmlFor="product-image-alt">
                  {t('productImages.altLabel')}
                </label>
                <input
                  id="product-image-alt"
                  className="input"
                  maxLength={200}
                  value={altText}
                  onChange={(e) => setAltText(e.target.value)}
                />
                <div className="mt-auto flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-primary min-h-11 flex-1 text-sm disabled:opacity-50 sm:flex-none"
                    onClick={() => void upload()}
                    disabled={busy === 'upload'}
                    data-testid="product-image-upload"
                  >
                    {busy === 'upload' ? t('productImages.uploading') : t('productImages.upload')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary min-h-11 flex-1 text-sm sm:flex-none"
                    onClick={clearPending}
                    disabled={busy === 'upload'}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700" role="alert" data-testid="product-image-error">
            {error}
          </p>
        )}
        {notice && (
          <p className="mb-3 rounded bg-emerald-50 p-2 text-sm text-emerald-700" role="status" aria-live="polite">
            {notice}
          </p>
        )}

        {loading ? (
          <Spinner />
        ) : images.length === 0 ? (
          <EmptyState title={t('productImages.empty')} hint={t('productImages.emptyHint')} />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="product-image-grid">
            {images.map((img) => (
              <li key={img.id} className="overflow-hidden rounded-lg border border-slate-200">
                <div className="relative">
                  <img
                    src={img.url}
                    alt={img.altText ?? productName}
                    loading="lazy"
                    className="h-28 w-full object-cover"
                    data-testid={`product-image-thumb-${img.id}`}
                  />
                  {img.isPrimary && (
                    <span className="absolute start-1 top-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {t('productImages.cover')}
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1 p-2">
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-2 text-xs text-slate-600 hover:border-wasit-400 hover:text-wasit-700 disabled:opacity-40"
                    onClick={() => void makeCover(img.id)}
                    disabled={img.isPrimary || busy !== null}
                    data-testid={`product-image-cover-${img.id}`}
                  >
                    {t('productImages.makeCover')}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-red-200 px-2 py-2 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
                    onClick={() => void remove(img.id)}
                    disabled={busy !== null}
                    data-testid={`product-image-delete-${img.id}`}
                  >
                    {t('productImages.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
