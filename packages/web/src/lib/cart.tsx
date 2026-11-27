import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Cart storage.
 *
 * The cart holds identity and quantity only. Prices, availability, commission
 * and totals are never stored as truth: they come from the server quote at the
 * moment they are shown, so a stale browser copy cannot become the price of an
 * order. The cached name/price/image are kept for the anonymous view (where the
 * quote endpoint is not available) and are always overwritten by server data.
 */

export interface CartLine {
  productId: string;
  quantity: number;
  /** Display-only snapshot; never sent to the server as a price. */
  name: string;
  price: string;
  currencyCode: string;
  sellerId: string;
  sellerType: string;
  moq: number;
  image: string | null;
  addedAt: number;
}

export type CartInput = Omit<CartLine, 'quantity' | 'addedAt'> & { quantity?: number };

const STORAGE_KEY = 'wasit.cart.v1';
/** Matches the server's per-basket line cap. */
export const MAX_CART_LINES = 50;
const MAX_QUANTITY = 999;

function clampQuantity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_QUANTITY, Math.max(1, Math.trunc(value)));
}

function isLine(value: unknown): value is CartLine {
  if (!value || typeof value !== 'object') return false;
  const line = value as Record<string, unknown>;
  return typeof line.productId === 'string'
    && line.productId.length > 0
    && typeof line.quantity === 'number'
    && Number.isFinite(line.quantity);
}

function normalize(line: CartLine): CartLine {
  return {
    productId: line.productId,
    quantity: clampQuantity(line.quantity),
    name: typeof line.name === 'string' ? line.name : '',
    price: typeof line.price === 'string' ? line.price : '0',
    currencyCode: typeof line.currencyCode === 'string' ? line.currencyCode : '',
    sellerId: typeof line.sellerId === 'string' ? line.sellerId : '',
    sellerType: typeof line.sellerType === 'string' ? line.sellerType : '',
    moq: typeof line.moq === 'number' && line.moq > 0 ? line.moq : 1,
    image: typeof line.image === 'string' ? line.image : null,
    addedAt: typeof line.addedAt === 'number' ? line.addedAt : Date.now(),
  };
}

function readStored(): CartLine[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLine).map(normalize).slice(0, MAX_CART_LINES);
  } catch {
    return [];
  }
}

interface CartCtx {
  lines: CartLine[];
  /** Sum of quantities, for the header badge. */
  count: number;
  items: { productId: string; quantity: number }[];
  add: (line: CartInput) => void;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  has: (productId: string) => boolean;
}

const Ctx = createContext<CartCtx | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(readStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // A full or blocked storage must not break browsing; the cart then lives
      // for this tab only.
    }
  }, [lines]);

  // Another tab changed the cart: adopt its version instead of overwriting it
  // on the next write.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setLines(readStored());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const add = useCallback((line: CartInput) => {
    setLines((current) => {
      const existing = current.find((l) => l.productId === line.productId);
      const quantity = clampQuantity(line.quantity ?? 1);
      if (existing) {
        return current.map((l) =>
          l.productId === line.productId
            ? { ...l, ...normalize({ ...l, ...line, quantity: l.quantity + quantity, addedAt: l.addedAt } as CartLine) }
            : l,
        );
      }
      if (current.length >= MAX_CART_LINES) return current;
      return [...current, normalize({ ...line, quantity, addedAt: Date.now() } as CartLine)];
    });
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    setLines((current) =>
      current.map((l) => (l.productId === productId ? { ...l, quantity: clampQuantity(quantity) } : l)),
    );
  }, []);

  const remove = useCallback((productId: string) => {
    setLines((current) => current.filter((l) => l.productId !== productId));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartCtx>(() => ({
    lines,
    count: lines.reduce((sum, l) => sum + l.quantity, 0),
    items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
    add,
    setQuantity,
    remove,
    clear,
    has: (productId: string) => lines.some((l) => l.productId === productId),
  }), [lines, add, setQuantity, remove, clear]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart(): CartCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
