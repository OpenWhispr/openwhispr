const { platformColor } = require('nativewind/theme');

const BRAND = '#007AFF';

const ios = (iosName, androidFallback, web = androidFallback) =>
  platformColor(iosName, androidFallback, web);

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.{js,jsx,ts,tsx}', './app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        brand: BRAND,

        label: ios('label', '#000000', '#000000'),
        secondaryLabel: ios('secondaryLabel', '#3C3C434D', '#3C3C434D'),
        tertiaryLabel: ios('tertiaryLabel', '#3C3C434D', '#3C3C434D'),
        quaternaryLabel: ios('quaternaryLabel', '#3C3C432E', '#3C3C432E'),

        systemBackground: '#F8F6F5',
        secondarySystemBackground: ios('secondarySystemBackground', '#F2F2F7', '#F2F2F7'),
        secondarySystemGroupedBackground: '#FFFFFF',
        tertiarySystemFill: ios('tertiarySystemFill', '#76768014', '#76768014'),
        quaternarySystemFill: ios('quaternarySystemFill', '#7676800F', '#7676800F'),

        separator: ios('separator', '#3C3C4349', '#3C3C4349'),
        link: ios('link', BRAND, BRAND),

        systemRed: ios('systemRed', '#FF3B30', '#FF3B30'),
        systemGreen: ios('systemGreen', '#34C759', '#34C759'),
        systemBlue: ios('systemBlue', BRAND, BRAND),
        systemOrange: ios('systemOrange', '#FF9500', '#FF9500'),

        border: 'hsl(214.3 31.8% 91.4%)',
        input: 'hsl(214.3 31.8% 91.4%)',
        ring: BRAND,
        background: 'hsl(0 0% 100%)',
        foreground: 'hsl(222.2 84% 4.9%)',
        primary: {
          DEFAULT: BRAND,
          foreground: 'hsl(210 40% 98%)',
        },
        secondary: {
          DEFAULT: 'hsl(210 40% 96.1%)',
          foreground: 'hsl(222.2 47.4% 11.2%)',
        },
        destructive: {
          DEFAULT: 'hsl(0 84.2% 60.2%)',
          foreground: 'hsl(210 40% 98%)',
        },
        muted: {
          DEFAULT: 'hsl(210 40% 96.1%)',
          foreground: 'hsl(215.4 16.3% 46.9%)',
        },
        accent: {
          DEFAULT: 'hsl(210 40% 96.1%)',
          foreground: 'hsl(222.2 47.4% 11.2%)',
        },
        popover: {
          DEFAULT: 'hsl(0 0% 100%)',
          foreground: 'hsl(222.2 84% 4.9%)',
        },
        card: {
          DEFAULT: 'hsl(0 0% 100%)',
          foreground: 'hsl(222.2 84% 4.9%)',
        },
      },
      borderRadius: {
        lg: '0.5rem',
        md: '0.375rem',
        sm: '0.25rem',
      },
      fontFamily: {
        sans: ['SpaceGrotesk_400Regular'],
      },
    },
  },
  plugins: [],
};
