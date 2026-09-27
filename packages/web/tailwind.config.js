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
        // Design tokens — modern global trade platform.
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        navy: {
          DEFAULT: '#0f172a',
          700: '#1a2438',
          800: '#131c31',
          900: '#0b1220',
        },
        teal: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
        },
        canvas: '#f8fafc',
        // Deep institutional blue — reserved for the public landing surfaces
        // (hero, dark bands, footer). Additive: dashboards keep using `navy`.
        ink: {
          50: '#eef3ff',
          100: '#dbe5ff',
          200: '#bccdff',
          300: '#8fa8f7',
          400: '#5f7ceb',
          500: '#3d59d6',
          600: '#2c41b4',
          700: '#233390',
          800: '#0f1f52',
          900: '#081335',
          950: '#050c24',
        },
      },
      fontFamily: {
        sans: ['Inter var', 'Inter', 'Segoe UI', 'Tahoma', 'Noto Sans Arabic', 'Noto Sans SC', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 4px 24px -8px rgba(15, 23, 42, 0.14)',
        card: '0 1px 3px rgba(15, 23, 42, 0.08), 0 8px 24px -12px rgba(15, 23, 42, 0.14)',
        lift: '0 12px 32px -12px rgba(15, 23, 42, 0.22)',
        // Landing-specific elevation: wide, low-opacity blue-tinted shadows.
        panel: '0 24px 60px -28px rgba(8, 19, 53, 0.35)',
        glow: '0 30px 90px -40px rgba(37, 99, 235, 0.55)',
      },
    },
  },
  plugins: [],
};