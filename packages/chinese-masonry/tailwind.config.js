export default {
  content: ['./demo/index.html', './demo/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#2c1810',
        parchment: '#f5f0e8',
        cinnabar: '#a03020',
      },
      fontFamily: {
        song: ['STSong', 'Noto Serif SC', 'SimSun', 'serif'],
        kai: ['STKaiti', 'KaiTi', 'serif'],
      },
    },
  },
  plugins: [],
};
