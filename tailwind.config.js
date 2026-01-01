/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        periwinkle: {
          DEFAULT: '#5B6DC4',
          50: '#E8EAFA',
          100: '#D1D5F5',
          200: '#A3ABE9',
          300: '#7581DE',
          400: '#5B6DC4',
          500: '#4A5AB3',
          600: '#3A4890',
          700: '#2A356D',
          800: '#1A234A',
          900: '#0A1027',
        },
      },
    },
  },
  plugins: [],
}
