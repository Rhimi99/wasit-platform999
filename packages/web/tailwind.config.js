/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        wasit: {
          // الهوية اللونية: Blue-Gray / أزرق رمادي احترافي
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          brand: '#475569',      // blue-gray (wasit-600)
          brandDark: '#334155',  // blue-gray (wasit-700)
          accent: '#4f46e5',     // indigo
          surface: '#0f172a',    // slate-900
          alt: '#5b7c99',        // أزرق هادئ رمادي
          altDark: '#44627e',
        },
      },
      boxShadow: {
        soft: '0 4px 24px -8px rgba(51, 65, 85, 0.18)',
        card: '0 1px 3px rgba(15, 23, 42, 0.08), 0 8px 24px -12px rgba(15, 23, 42, 0.14)',
      },
    },
  },
  plugins: [],
};